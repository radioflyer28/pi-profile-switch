#!/usr/bin/env node
/**
 * pi-profile launcher (ADR-0005).
 *
 * Resolves the initial profile, materializes it as a generated runtime
 * directory (settings + platform mirror + env), and spawns the real `pi`
 * binary with user arguments passed through verbatim.
 *
 * Usage:
 *   pi-profile                          # default profile
 *   pi-profile review                   # named profile (once catalogs land)
 *   pi-profile review -- --mode rpc --model openai/gpt-5.4
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { ExtensionError } from "../src/extension-discovery.ts";
import { parseLauncherArgs } from "../src/launcher/args.ts";
import { UnknownProfileError, resolveInitialProfile } from "../src/launcher/initial-profile.ts";
import { untrustedProjectDiagnostic } from "../src/launcher/untrusted-project-diagnostic.ts";
import { sweepStaleInstances } from "../src/launcher/runtime-cleanup.ts";
import { spawnPi } from "../src/launcher/spawn.ts";
import { McpConfigError, MissingMcpAdapterError } from "../src/mcp-config.ts";
import { CatalogError } from "../src/profile-catalog.ts";
import { ActivationError } from "../src/profile-resolver.ts";
import { ensureStarterAssets } from "../src/starter-assets.ts";
import { generateRuntimeDir } from "../src/settings-generator.ts";

try {
	const args = parseLauncherArgs(process.argv.slice(2));
	const agentDir = getAgentDir();
	// Starter assets (seed profile + profile-config skill) are ensured before
	// initial profile resolution so the seed is visible to this launch's
	// resolution and /profile list. Best-effort: ensure failures never block
	// the launch (same pattern as the sweep below).
	const starterAssets = await ensureStarterAssets({ agentDir });
	for (const warning of starterAssets.warnings) {
		console.error(`pi-profile: warning: ${warning}`);
	}
	// Fails before spawning when the profile is unknown or cannot activate.
	// --approve/--no-approve are consumed here as a one-run trust input.
	const { plan, discovery, projectDir, projectTrusted, warnings } = await resolveInitialProfile(args.profile, {
		agentDir,
		cwd: process.cwd(),
		trustOverride: args.trustOverride,
	});
	for (const warning of warnings) {
		console.error(`pi-profile: warning: ${warning}`);
	}
	// Untrusted-project notice: fires identically for every profile (default
	// included) because it is driven by the trust determination, not by which
	// profile branch resolution took. Startup continues either way.
	const untrustedNotice = untrustedProjectDiagnostic(process.cwd(), projectTrusted);
	if (untrustedNotice) {
		console.error(`pi-profile: warning: ${untrustedNotice}`);
	}
	// Stale per-launch instance dirs (dead pid, or no pid past the grace
	// window) are swept before this launch materializes its own. Unrecognized
	// entries are dispositioned per content scan: kept + reported when they
	// reference the instance path or cannot be cleared, adopted into the real
	// agent dir, or deleted on a name conflict (real wins) — all with a stderr
	// notice (ADR-0012). Best-effort: sweep errors never block the launch.
	const sweep = await sweepStaleInstances(agentDir);
	for (const notice of sweep.notices) {
		console.error(`pi-profile: notice: ${notice}`);
	}
	for (const warning of sweep.warnings) {
		console.error(`pi-profile: warning: ${warning}`);
	}
	const generated = await generateRuntimeDir(plan, { agentDir, discovery, projectDir });
	process.exitCode = await spawnPi({
		generated,
		piArgs: args.piArgs,
		// Re-applied for every profile: the one-run trust input must decide both
		// the resolver's project reads and Pi's project-scope visibility — two
		// different answers in one launch would be a divergence, not a policy.
		trustOverride: args.trustOverride,
	});
} catch (error) {
	// Launcher input/selection failures (unknown profile, unresolvable
	// references, missing adapter, malformed catalogs) are usage errors:
	// exit 2. Unexpected failures: exit 1.
	const isUsageError =
		error instanceof UnknownProfileError ||
		error instanceof ActivationError ||
		error instanceof ExtensionError ||
		error instanceof MissingMcpAdapterError ||
		error instanceof McpConfigError ||
		error instanceof CatalogError;
	console.error(error instanceof Error ? `pi-profile: ${error.message}` : error);
	process.exitCode = isUsageError ? 2 : 1;
}
