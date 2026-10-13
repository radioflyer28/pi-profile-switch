import crossSpawn from "cross-spawn";

import { launcherEnv } from "./launcher-runner.ts";
import type { PiFixture } from "./pi-fixture.ts";
import { RpcDriver } from "./rpc-driver.ts";

function nativeEnv(fixture: PiFixture): NodeJS.ProcessEnv {
	const env = launcherEnv(fixture);
	// Match the launcher's native child environment, not an ambient session root.
	delete env.PI_CODING_AGENT_SESSION_DIR;
	return env;
}

/** Native comparison only: the same executable the launcher starts. */
export function runNativePiRpc(fixture: PiFixture, args: string[]): RpcDriver {
	return new RpcDriver("pi", args, { cwd: fixture.cwd, env: nativeEnv(fixture) });
}

export interface NativePiRun {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/** EOF permits native RPC to exit without requests. Timeout/spawn errors are
 *  harness failures; actual native exit codes/signals remain comparison data. */
export function runNativePi(fixture: PiFixture, args: string[]): Promise<NativePiRun> {
	return new Promise((resolve, reject) => {
		const child = crossSpawn.spawn("pi", args, { cwd: fixture.cwd, env: nativeEnv(fixture), windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("native Pi harness timed out"));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(new Error(`native Pi harness failed: ${error.message}\n${stderr}`));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
		child.stdin?.end();
	});
}
