/**
 * Spawns the real `pi` binary as a subprocess (ADR-0005).
 *
 * The spawned pi gets: the pi-profile extension via `-e` and the user's
 * arguments verbatim. cross-spawn resolves npm's Windows `pi.cmd` shim
 * while preserving an argv-based launch instead of evaluating a shell command
 * string. stdio is inherited so interactive TUI, RPC, and print modes all
 * behave natively; exit codes and signals propagate.
 */

import crossSpawn from "cross-spawn";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reconcileDeferredRuntimeFiles, type MirrorReconciliationResult } from "../runtime-mirror.ts";
import type { GeneratedRuntime } from "../settings-generator.ts";

export interface SpawnPiOptions {
	/** Generated runtime dir + env. */
	generated: GeneratedRuntime;
	/** User arguments, forwarded verbatim. */
	piArgs: string[];
	/** Trust override recorded by the launcher; re-applied natively for the default profile. */
	trustOverride: boolean | undefined;
}

const EXTENSION_ENTRY = fileURLToPath(new URL("../../extensions/pi-profile/index.ts", import.meta.url));

/** Pure argv construction for the spawned pi: extension entry,
 *  trust re-application, then user args verbatim. */
export function buildPiArgs(options: SpawnPiOptions): string[] {
	const args = ["-e", EXTENSION_ENTRY];
	// Re-apply the recorded one-run trust input for every profile: the same input
	// decided the launcher's project reads, so Pi must decide the same way.
	if (options.trustOverride === true) args.push("--approve");
	if (options.trustOverride === false) args.push("--no-approve");
	args.push(...options.piArgs);
	return args;
}

export async function reconcileGeneratedRuntime(generated: GeneratedRuntime): Promise<MirrorReconciliationResult> {
	return reconcileDeferredRuntimeFiles(generated.runtimeDir, generated.agentDir);
}

export async function spawnPi(options: SpawnPiOptions): Promise<number> {
	const env = { ...process.env, ...options.generated.env };
	delete env.PI_CODING_AGENT_SESSION_DIR;

	const child = crossSpawn("pi", buildPiArgs(options), {
		stdio: "inherit",
		env,
	});

	// Liveness token for the next launch's startup sweep (runtime-cleanup.ts).
	// Best-effort: the dir was just written by generateRuntimeDir, so this can
	// only fail under disk/permission trouble that would have surfaced earlier.
	if (child.pid !== undefined) {
		try {
			await writeFile(path.join(options.generated.runtimeDir, "pid"), String(child.pid));
		} catch (error) {
			console.error(`pi-profile: warning: could not write pid file: ${(error as Error).message}`);
		}
	}

	const onSigint = () => child.kill("SIGINT");
	const onSigterm = () => child.kill("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	let exitCode: number;
	try {
		exitCode = await new Promise<number>((resolve, reject) => {
			child.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") {
					reject(new Error(`pi binary not found on PATH`));
				} else {
					reject(error);
				}
			});
			child.on("exit", (code, signal) => {
				if (code !== null) resolve(code);
				else resolve(signal === "SIGINT" ? 130 : 1);
			});
		});
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}

	// Windows cannot create dangling hard links. State files missing at launch
	// are therefore reconciled after Pi exits; a later startup sweep repeats
	// this operation if the launcher is interrupted before reaching this point.
	try {
		const reconciliation = await reconcileGeneratedRuntime(options.generated);
		for (const notice of reconciliation.notices) console.error(`pi-profile: notice: ${notice}`);
		for (const warning of reconciliation.warnings) console.error(`pi-profile: warning: ${warning}`);
	} catch (error) {
		console.error(
			`pi-profile: warning: could not reconcile runtime state: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return exitCode;
}
