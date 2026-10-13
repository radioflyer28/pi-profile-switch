import { existsSync } from "node:fs";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { WINDOWS_MIRROR_MANIFEST } from "../../src/runtime-mirror.ts";

/** Prove native file routing, not the POSIX-only representation. */
export async function expectSharedRuntimeFile(runtimeFile: string, agentFile: string): Promise<void> {
	if (process.platform !== "win32") {
		expect((await lstat(runtimeFile)).isSymbolicLink()).toBe(true);
		expect(await readlink(runtimeFile)).toBe(agentFile);
		return;
	}
	if (!existsSync(agentFile)) {
		expect(existsSync(runtimeFile)).toBe(false);
		const manifest = JSON.parse(await readFile(path.join(path.dirname(runtimeFile), WINDOWS_MIRROR_MANIFEST), "utf8"));
		expect(manifest.entries[path.basename(runtimeFile)]).toBe("deferred-file");
		return;
	}
	const [runtime, agent] = await Promise.all([stat(runtimeFile), stat(agentFile)]);
	expect(runtime.isFile()).toBe(true);
	expect(runtime.ino).toBe(agent.ino);
	expect(runtime.dev).toBe(agent.dev);
}

/** Retain the same runtime link or hard-link identity across a live switch. */
export async function runtimeFileIdentity(filePath: string): Promise<unknown> {
	const info = await lstat(filePath);
	return info.isSymbolicLink() ? { kind: "symlink", target: await readlink(filePath) }
		: { kind: "file", ino: info.ino, dev: info.dev };
}
