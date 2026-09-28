/**
 * SettingsGenerator: materializes an ActivationPlan as a pi-profile-owned
 * runtime directory (ADR-0005).
 *
 * Two entry points:
 * - `generateRuntimeDir` (launcher): create a fresh per-launch runtime dir
 *   under the workspace instances root, write the files, mirror the real
 *   agent dir through the platform backend, derive env.
 * - `writeRuntimeFiles` (in-session switch, ticket 05): rewrite
 *   settings.json + pi-profile.json inside the EXISTING runtime dir (the
 *   running process's PI_CODING_AGENT_DIR cannot move), and transition the
 *   trust.json link to match the new plan's filter mode.
 *
 * For the built-in `default` profile the generated settings preserve the
 * user's global settings untouched and re-include the real agent dir's
 * resource dirs (their discovery root moves with `PI_CODING_AGENT_DIR`), so
 * the spawned pi behaves exactly like native `pi`.
 *
 * For named profiles the generated settings encode the profile's selection
 * over user-scope resources only (see docs/architecture/overview.md):
 * - agentDir-scope resources: additive allowlist paths (the discovery root
 *   moved, so nothing auto-discovered from the real agent dir)
 * - `~/.agents` skills: always auto-discovered, so unselected ones are
 *   force-excluded with `-<path>` entries
 * - packages: user-configured package entries rewritten to object form with
 *   per-type allowlists (unmanaged types keep the user's key or Pi's default)
 * - project-scope resources (project `.pi/skills`, project `.pi/extensions`,
 *   ancestor `.agents/skills`) are never encoded: Pi discovers them natively
 *   whenever the project is trusted, and the profile neither adds nor
 *   excludes them
 * - `defaultProjectTrust: "never"` only suppresses Pi's interactive trust
 *   prompt (a stored decision in the real trust.json still applies); the
 *   project's `.pi/settings.json` is not merged here — Pi reads it natively
 * - unmanaged kinds (prompts, themes) pass through: the user's arrays are
 *   preserved and the real agent dir's prompts/themes dirs re-included
 * - tools/model are written to generated settings (defaultTools,
 *   defaultProvider, defaultModel, defaultThinkingLevel); the launch plan
 *   file feeds the in-pi extension (tools strict allowlist, status)
 *
 * User configuration files are never modified.
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ActivationPlan } from "./profile-resolver.ts";
import { getInstancesRootDir } from "./workspace.ts";
import { isRecord } from "./json-file.ts";
import { loadMergedMcpServers } from "./mcp-config.ts";
import type { SkillEntry } from "./skill-registry.ts";
import {
	ensureSharedRuntimeFile,
	syncAgentMirror,
	WINDOWS_MIRROR_MANIFEST,
} from "./runtime-mirror.ts";

/** A configured global package and its resolved install/local root. */
export interface ConfiguredPackageRoot {
	/** The source string exactly as written in the user's settings. */
	source: string;
	/** Absolute install/local root; undefined when not resolvable offline. */
	root?: string;
}

/** Full discovery results the generator needs beyond the plan itself:
 *  the complete skill set (for `~/.agents` exclusions) and configured
 *  package roots (for classifying extension entries). */
export interface DiscoveryContext {
	skills: SkillEntry[];
	packages: ConfiguredPackageRoot[];
}

export interface GenerateOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Optional home dir override (useful for testing). */
	homeDir?: string;
	/** Optional trusted project dir. */
	projectDir?: string;
	/** Required for selection plans; unused for the default profile. */
	discovery?: DiscoveryContext;
	/** Test seam; production callers use process.platform. */
	platform?: NodeJS.Platform;
}

export interface GeneratedRuntime {
	/** The generated runtime directory (becomes PI_CODING_AGENT_DIR). */
	runtimeDir: string;
	/** Environment variables for the spawned pi process. */
	env: Record<string, string>;
	/** The user's real agent dir, used for post-child state reconciliation. */
	agentDir: string;
}

/** Files managed explicitly by pi-profile in runtimeDir; excluded from automatic mirroring. */
export const MANAGED_INSTANCE_FILES = new Set([
	"settings.json",
	"mcp.json",
	"APPEND_SYSTEM.md",
	"pi-profile.json",
	"trust.json",
	"pid",
	"extensions",
	WINDOWS_MIRROR_MANIFEST,
]);

/** State directories that Pi and its extensions resolve under the agent dir,
 *  and which therefore appear at runtime rather than at install time. They are
 *  seeded in the REAL agent dir before mirroring, so the instance gets a
 *  platform directory link instead of a private real directory: state then
 *  lands where native Pi puts it, and third-party records never embed an
 *  instance path (ADR-0010). Adding a name here needs observed evidence that a
 *  package creates that directory under the agent dir; anything unlisted shows
 *  up as an unrecognized entry in the sweep (src/launcher/runtime-cleanup.ts). */
const SEEDED_STATE_DIRS = ["sessions", "missions"] as const;

/** State FILES Pi creates at runtime (same evidence rule as the dirs). They
 *  cannot be created up front — the content is Pi's, not pi-profile's. POSIX
 *  instances get dangling links; Windows records deferred files and reconciles
 *  them after exit or during the next sweep (ADR-0015). */
const SEEDED_STATE_FILES = ["auth.json", "models-store.json"] as const;

/** Resource dirs rooted at the real agent dir, re-included for the default
 *  profile because PI_CODING_AGENT_DIR moves the discovery root. */
const RESOURCE_DIR_KINDS = ["skills", "extensions", "prompts", "themes"] as const;

/** Unmanaged resource dirs re-included for every profile (pi-profile does
 *  not manage prompt templates or themes). */
const UNMANAGED_DIR_KINDS = ["prompts", "themes"] as const;

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

function tryRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function isUnderPath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return true;
	}
	const normRelative = path.relative(tryRealpath(root), tryRealpath(target));
	return normRelative !== "" && !normRelative.startsWith("..") && !path.isAbsolute(normRelative);
}

/** The HOME-level ~/.agents/skills dir: always auto-discovered by Pi,
 *  unsuppressible via PI_CODING_AGENT_DIR, so it needs exclusion entries. */
function homeAgentsSkillsDir(): string {
	return path.join(process.env.HOME ?? homedir(), ".agents", "skills");
}

function buildSelectionSettings(
	plan: ActivationPlan,
	userSettings: Record<string, unknown>,
	agentDir: string,
	discovery: DiscoveryContext,
	runtimeDir: string,
	projectDir?: string,
): Record<string, unknown> {
	const settings = { ...userSettings };

	// --- skills ---
	// Only user-scope entries are encoded. Project-scope selections are
	// skipped below: their visibility is Pi's, so the order they would have
	// been emitted in carries no meaning.
	const selectedPaths = new Set(plan.skills.map((skill) => skill.filePath));
	const skillEntries: string[] = [];
	for (const skill of plan.skills) {
		if (skill.origin === "package") continue; // encoded in the packages allowlist
		// Project scope belongs to Pi: a trusted project's skills are discovered
		// natively, so selecting one here would duplicate it and excluding one
		// would contradict the profile's boundary.
		if (skill.scope === "project") continue;
		if (isUnderPath(skill.filePath, homeAgentsSkillsDir())) continue; // auto-discovered anyway
		skillEntries.push(skill.filePath);
	}
	for (const skill of discovery.skills) {
		if (skill.origin === "package") continue;
		if (skill.scope === "project") continue;
		if (selectedPaths.has(skill.filePath)) continue;
		
		// If the skill is in the real agentDir, Pi discovers it through the
		// instance mirror. Exclude that lexical mirror path so Pi excludes it.
		// Lexical paths only: Pi matches `-` exclusions against the raw
		// discovered path without resolving symlinks. Resolving realpaths here
		// escapes runtimeDir whenever an agentDir skill is a symlink to outside
		// the agent dir, and the exclusion then silently matches nothing.
		if (isUnderPath(skill.filePath, agentDir)) {
			const rel = path.relative(agentDir, skill.filePath);
			skillEntries.push(`-${path.join(runtimeDir, rel)}`);
		} else {
			skillEntries.push(`-${skill.filePath}`);
		}
	}
	settings.skills = skillEntries;

	// --- extensions ---
	// Entries under a package root are encoded in that package's allowlist;
	// everything else becomes an additive absolute path.
	const packageRoots = discovery.packages
		.filter((pkg): pkg is ConfiguredPackageRoot & { root: string } => pkg.root !== undefined)
		.map((pkg) => ({ ...pkg, root: pkg.root }));
	const packageExtensions = new Map<string, string[]>();
	const extensionEntries: string[] = [];
	const projectExtensionsDir =
		projectDir !== undefined ? path.join(projectDir, ".pi", "extensions") : undefined;
	for (const extension of plan.extensions) {
		// Loose project extensions are discovered natively by Pi; an explicit
		// path reference inside the project (outside `.pi/extensions`) is the
		// profile's own selection and stays.
		if (projectExtensionsDir !== undefined && isUnderPath(extension.entry, projectExtensionsDir)) continue;
		const owner = packageRoots.find((pkg) => isUnderPath(extension.entry, pkg.root));
		if (owner === undefined) {
			extensionEntries.push(extension.entry);
		} else {
			const list = packageExtensions.get(owner.source) ?? [];
			list.push(toPosix(path.relative(owner.root, extension.entry)));
			packageExtensions.set(owner.source, list);
		}
	}
	settings.extensions = extensionEntries;

	// --- packages ---
	const userPackages = Array.isArray(userSettings.packages) ? userSettings.packages : [];
	if (userPackages.length > 0) {
		const packageSkills = new Map<string, string[]>();
		for (const skill of plan.skills) {
			if (skill.origin !== "package" || skill.baseDir === undefined) continue;
			const list = packageSkills.get(skill.source) ?? [];
			list.push(toPosix(path.relative(skill.baseDir, skill.filePath)));
			packageSkills.set(skill.source, list);
		}
		settings.packages = userPackages.map((pkg) => {
			const source = typeof pkg === "string" ? pkg : (pkg as { source: string }).source;
			const base: Record<string, unknown> =
				typeof pkg === "object" && pkg !== null ? { ...(pkg as Record<string, unknown>) } : { source };
			delete base.extensions;
			delete base.skills;
			const rewritten: Record<string, unknown> = {
				source,
				...base,
				skills: packageSkills.get(source) ?? [],
				extensions: packageExtensions.get(source) ?? [],
			};
			return rewritten;
		});
	}

	// --- unmanaged dirs pass through (prompts/themes) ---
	for (const kind of UNMANAGED_DIR_KINDS) {
		const resourceDir = path.join(agentDir, kind);
		if (existsSync(resourceDir)) {
			const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
			settings[kind] = [...entries, resourceDir];
		}
	}

	// --- profile defaults (Ticket 04) ---
	if (plan.model !== undefined) {
		settings.defaultProvider = plan.model.provider;
		settings.defaultModel = plan.model.id;
		if (plan.model.thinkingLevel !== undefined) {
			settings.defaultThinkingLevel = plan.model.thinkingLevel;
		} else {
			delete settings.defaultThinkingLevel;
		}
	}
	if (plan.tools !== undefined) {
		settings.defaultTools = plan.tools;
	}

	// Project auto-discovery is suppressed entirely; selected project
	// resources enter additively through the trust-gated resolver.
	settings.defaultProjectTrust = "never";
	return settings;
}

export interface RuntimeFileOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Optional home dir override (useful for testing). */
	homeDir?: string;
	/** Optional trusted project dir. */
	projectDir?: string;
	/** Required for selection plans; unused for the default profile. */
	discovery?: DiscoveryContext;
	/** Test seam; production callers use process.platform. */
	platform?: NodeJS.Platform;
	/** Extra launch-plan fields written by the in-session switch path:
	 *  `switchedFrom` triggers the one-shot change summary; `persistSelection`
	 *  tells the post-reload extension instance to save the selection;
	 *  `clearOverlay` drops the stored overlay
	 *  (a profile switch discards the previous profile's overlay).
	 *  `previousResolved` carries the pre-switch resolved name sets so
	 *  `/profile status` can report glob deltas (ticket 07). */
	planExtras?: {
		switchedFrom?: string;
		persistSelection?: boolean;
		clearOverlay?: boolean;
		previousResolved?: ResolvedNames;
	};
}

/** Computes the generated settings for a plan (pure-ish: reads the user's
 *  real settings + unmanaged dir existence, writes nothing). */
async function computeSettings(
	plan: ActivationPlan,
	options: RuntimeFileOptions,
	runtimeDir: string,
): Promise<Record<string, unknown>> {
	const { agentDir } = options;
	const userSettingsPath = path.join(agentDir, "settings.json");
	const userSettings: Record<string, unknown> = (await exists(userSettingsPath))
		? JSON.parse(await readFile(userSettingsPath, "utf8"))
		: {};

	if (plan.filter === "none") {
		// default profile: the user's global settings plus re-inclusion of the
		// real agent dir's resource dirs. User-defined keys, including their own
		// resource patterns and enable/disable state, are preserved untouched.
		// Project settings are NOT merged here: with native trust behavior, Pi
		// reads the project's settings itself.
		const settings = { ...userSettings };
		for (const kind of RESOURCE_DIR_KINDS) {
			const resourceDir = path.join(agentDir, kind);
			if (await exists(resourceDir)) {
				const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
				settings[kind] = [...entries, resourceDir];
			}
		}
		return settings;
	}

	// Selection plans: only user-scope encoding is layered onto the user's own
	// settings. The trusted project's `.pi/settings.json` is deliberately NOT
	// merged here — Pi reads it natively for the same trust decision this
	// process's Pi applies, and merging it would turn the project's `packages`
	// into global-scope packages (installing them into the real agent dir's npm
	// root as a launch side effect).
	return buildSelectionSettings(
		plan,
		{ ...userSettings },
		agentDir,
		options.discovery ?? { skills: [], packages: [] },
		runtimeDir,
		options.projectDir,
	);
}

/** Resolved name sets, carried in the launch plan for glob-delta reporting. */
export interface ResolvedNames {
	skills: string[];
	extensions: string[];
	tools?: string[];
	mcps?: string[];
}

/** Writes settings.json + pi-profile.json into an existing runtime dir and
 *  keeps the trust.json link in place for every profile: Pi reads its
 *  project-scope decision from that path, and project-level resources belong
 *  to Pi's trust gate rather than to the profile. */
export async function writeRuntimeFiles(
	runtimeDir: string,
	plan: ActivationPlan,
	options: RuntimeFileOptions,
): Promise<void> {
	const settings = await computeSettings(plan, options, runtimeDir);
	await writeFile(path.join(runtimeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

	// The launch plan feeds the in-pi extension: tool re-application after
	// reload (the tools strict allowlist), in-session switching, status
	// reporting, and post-reload state persistence.
	// agentDir is the REAL agent dir — the extension needs it for trust
	// checks, state files, and catalog reads (its own
	// PI_CODING_AGENT_DIR points at this runtime dir).
	await writeFile(
		path.join(runtimeDir, "pi-profile.json"),
		`${JSON.stringify(
			{
				profile: plan.profile,
				source: plan.source,
				agentDir: options.agentDir,
				...(plan.tools !== undefined ? { tools: plan.tools } : {}),
				...(plan.toolReferences !== undefined ? { toolReferences: plan.toolReferences } : {}),
				...(plan.disabledTools !== undefined ? { disabledTools: plan.disabledTools } : {}),
				...(plan.mcps !== undefined ? { mcps: plan.mcps } : {}),
				// The resolved sets feed /profile status (absolute paths) and the
				// glob-delta diff against the previous activation.
				resolved: {
					skills: plan.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
					extensions: plan.extensions,
				},
				// Zero-match glob references (ADR-0009) — surfaced by /profile status
				// so a typo'd glob is visible instead of silently selecting nothing.
				...(plan.unmatched !== undefined ? { unmatched: plan.unmatched } : {}),
				...options.planExtras,
			},
			null,
			2,
		)}\n`,
	);

	// Every profile gets the link, dangling allowed: Pi's stored trust decision
	// is what makes a trusted project's resources visible, and a decision Pi
	// writes through the link must land in the real agent dir (same shape as the
	// auth.json seed in ADR-0010). An entry that already exists is left alone —
	// a real file Pi wrote during this session carries its own decision.
	const trustLink = path.join(runtimeDir, "trust.json");
	await ensureSharedRuntimeFile(path.join(options.agentDir, "trust.json"), trustLink, {
		platform: options.platform,
		deferWhenMissing: true,
	});

	// MCP Servers generation (Ticket 04)
	const mcpTarget = path.join(options.agentDir, "mcp.json");
	const mcpInstancePath = path.join(runtimeDir, "mcp.json");
	if (plan.mcps === undefined) {
		// No restrictions: share the user's real file without rewriting it.
		if (await exists(mcpTarget)) {
			await ensureSharedRuntimeFile(mcpTarget, mcpInstancePath, {
				platform: options.platform,
				deferWhenMissing: false,
			});
		}
	} else {
		// Filter MCP servers
		try { await rm(mcpInstancePath); } catch {}
		const { servers, sharedServers, projectServers, baseConfig } = await loadMergedMcpServers(
			options.agentDir,
			options.projectDir,
			options.homeDir !== undefined ? { homeDir: options.homeDir } : undefined,
		);

		const allowedSet = new Set(plan.mcps);
		const filteredServers: Record<string, unknown> = {};

		for (const serverName of plan.mcps) {
			if (servers[serverName] !== undefined) {
				const def = { ...servers[serverName] };
				delete def.disabled;
				filteredServers[serverName] = def;
			}
		}

		for (const sharedName of sharedServers) {
			if (!allowedSet.has(sharedName)) {
				// Project-level servers are not the profile's to narrow (the same
				// boundary as project skills and extensions).
				if (projectServers.has(sharedName)) continue;
				filteredServers[sharedName] = { disabled: true };
			}
		}

		const outputConfig: Record<string, unknown> = isRecord(baseConfig)
			? { ...baseConfig, mcpServers: filteredServers }
			: { mcpServers: filteredServers };

		await writeFile(mcpInstancePath, JSON.stringify(outputConfig, null, 2));
	}

	// Instructions generation (Ticket 04)
	const appendSystemPath = path.join(runtimeDir, "APPEND_SYSTEM.md");
	if (plan.instructions !== undefined && plan.instructions.trim() !== "") {
		await writeFile(appendSystemPath, plan.instructions);
	} else {
		try { await rm(appendSystemPath); } catch {}
	}

	// Platform-appropriate full-fidelity mirroring and stale mirror cleanup.
	await seedRuntimeStateDirs(options.agentDir);
	await syncAgentMirror(options.agentDir, runtimeDir, MANAGED_INSTANCE_FILES, { platform: options.platform });
	await seedRuntimeStateFiles(options.agentDir, runtimeDir, options.platform);
}

/** Compatibility export retained for callers of the former POSIX-specific name. */
export async function syncAgentSymlinks(agentDir: string, runtimeDir: string): Promise<void> {
	await syncAgentMirror(agentDir, runtimeDir, MANAGED_INSTANCE_FILES);
}

async function seedRuntimeStateDirs(agentDir: string): Promise<void> {
	for (const name of SEEDED_STATE_DIRS) {
		try {
			await mkdir(path.join(agentDir, name), { recursive: true });
		} catch {
			// Best-effort: the mirror then simply links nothing for this name.
		}
	}
}

async function seedRuntimeStateFiles(
	agentDir: string,
	runtimeDir: string,
	platform?: NodeJS.Platform,
): Promise<void> {
	for (const name of SEEDED_STATE_FILES) {
		await ensureSharedRuntimeFile(path.join(agentDir, name), path.join(runtimeDir, name), {
			platform,
			deferWhenMissing: true,
		});
	}
}

export async function generateRuntimeDir(
	plan: ActivationPlan,
	options: GenerateOptions,
): Promise<GeneratedRuntime> {
	const { agentDir } = options;
	const runtimeRoot = getInstancesRootDir();
	await mkdir(runtimeRoot, { recursive: true });
	// One instance per launch, never reused: PI_CODING_AGENT_DIR is frozen for
	// the life of the spawned process, so a stable path cannot follow an
	// in-session switch, and a shared path would make concurrent launches (and
	// their switches) rewrite each other's files (ADR-0010).
	const runtimeDir = await mkdtemp(path.join(runtimeRoot, "launch-"));

	await writeRuntimeFiles(runtimeDir, plan, options);

	return {
		runtimeDir,
		env: {
			PI_CODING_AGENT_DIR: runtimeDir,
		},
		agentDir,
	};
}
