import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildPiArgs, reconcileGeneratedRuntime, spawnPi } from "../src/launcher/spawn.ts";
import { ensureSharedRuntimeFile } from "../src/runtime-mirror.ts";
import type { GeneratedRuntime } from "../src/settings-generator.ts";

const generated: GeneratedRuntime = {
	runtimeDir: "/tmp/runtime",
	env: { PI_CODING_AGENT_DIR: "/tmp/runtime" },
	agentDir: "/tmp/agent",
};

describe("buildPiArgs", () => {
	it("loads the pi-profile extension and forwards user args verbatim", () => {
		const args = buildPiArgs({ generated, piArgs: ["--mode", "rpc", "--continue"], trustOverride: undefined });
		expect(args[0]).toBe("-e");
		expect(args[1].endsWith(path.join("extensions", "pi-profile", "index.ts"))).toBe(true);
		expect(args.slice(2)).toEqual(["--mode", "rpc", "--continue"]);
	});

	it("re-applies a recorded --approve to the spawned pi", () => {
		const args = buildPiArgs({ generated, piArgs: [], trustOverride: true });
		expect(args).toContain("--approve");
	});

	it("re-applies a recorded --no-approve", () => {
		const args = buildPiArgs({ generated, piArgs: ["--mode", "rpc"], trustOverride: false });
		expect(args).toEqual(["-e", expect.any(String), "--no-approve", "--mode", "rpc"]);
	});

	it.runIf(process.platform === "win32")("launches Pi through an npm pi.cmd shim without a shell command string", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-profile-spawn-cmd-"));
		const agentDir = path.join(root, "agent");
		const runtimeDir = path.join(root, "runtime");
		const binDir = path.join(root, "bin");
		await Promise.all([mkdir(agentDir), mkdir(runtimeDir), mkdir(binDir)]);
		await writeFile(path.join(binDir, "pi.cmd"), "@echo off\r\nexit /b 23\r\n");
		const previousPath = process.env.PATH;
		process.env.PATH = binDir;
		try {
			await expect(
				spawnPi({
					generated: { runtimeDir, agentDir, env: { PI_CODING_AGENT_DIR: runtimeDir } },
					piArgs: ["literal & exit /b 99"],
					trustOverride: undefined,
				}),
			).resolves.toBe(23);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reconciles deferred Windows state after the child exits", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-profile-spawn-"));
		const agentDir = path.join(root, "agent");
		const runtimeDir = path.join(root, "runtime");
		await Promise.all([mkdir(agentDir), mkdir(runtimeDir)]);
		try {
			await ensureSharedRuntimeFile(path.join(agentDir, "auth.json"), path.join(runtimeDir, "auth.json"), {
				platform: "win32",
				deferWhenMissing: true,
			});
			await writeFile(path.join(runtimeDir, "auth.json"), "created after launch");

			const result = await reconcileGeneratedRuntime({
				runtimeDir,
				agentDir,
				env: { PI_CODING_AGENT_DIR: runtimeDir },
			});

			expect(result.warnings).toEqual([]);
			expect(await readFile(path.join(agentDir, "auth.json"), "utf8")).toBe("created after launch");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
