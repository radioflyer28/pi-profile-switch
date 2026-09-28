import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	ensureSharedRuntimeFile,
	inspectOwnedMirrorNames,
	reconcileDeferredRuntimeFiles,
	RuntimeMaterializationError,
	syncAgentMirror,
	WINDOWS_MIRROR_MANIFEST,
} from "../src/runtime-mirror.ts";

const roots: string[] = [];

async function fixture(parent = tmpdir()): Promise<{ root: string; agentDir: string; runtimeDir: string }> {
	const root = await mkdtemp(path.join(parent, "pi-profile-mirror-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	const runtimeDir = path.join(root, "runtime");
	await Promise.all([mkdir(agentDir), mkdir(runtimeDir)]);
	return { root, agentDir, runtimeDir };
}

async function sameIdentity(first: string, second: string): Promise<boolean> {
	const [a, b] = await Promise.all([stat(first), stat(second)]);
	return a.dev === b.dev && a.ino === b.ino;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Windows runtime mirror", () => {
	it("uses a junction entry for directories and a hard link for existing files", async () => {
		const { agentDir, runtimeDir } = await fixture();
		await mkdir(path.join(agentDir, "sessions"));
		await writeFile(path.join(agentDir, "auth.json"), '{"token":"one"}');

		await syncAgentMirror(agentDir, runtimeDir, new Set([WINDOWS_MIRROR_MANIFEST]), { platform: "win32" });

		expect(await realpath(path.join(runtimeDir, "sessions"))).toBe(await realpath(path.join(agentDir, "sessions")));
		expect(await sameIdentity(path.join(runtimeDir, "auth.json"), path.join(agentDir, "auth.json"))).toBe(true);
		expect((await lstat(path.join(runtimeDir, "auth.json"))).isSymbolicLink()).toBe(false);
		await writeFile(path.join(runtimeDir, "auth.json"), '{"token":"two"}');
		expect(await readFile(path.join(agentDir, "auth.json"), "utf8")).toBe('{"token":"two"}');

		const manifest = JSON.parse(await readFile(path.join(runtimeDir, WINDOWS_MIRROR_MANIFEST), "utf8"));
		expect(manifest.entries).toMatchObject({ sessions: "junction", "auth.json": "hardlink" });

		await writeFile(path.join(agentDir, "sessions", "keep.json"), "kept");
		await rm(runtimeDir, { recursive: true, force: true });
		expect(await readFile(path.join(agentDir, "sessions", "keep.json"), "utf8")).toBe("kept");
		expect(await readFile(path.join(agentDir, "auth.json"), "utf8")).toBe('{"token":"two"}');
	});

	it.skipIf(process.platform === "win32")("resolves source symlinks without reproducing a file symlink in the Windows instance", async () => {
		const { root, agentDir, runtimeDir } = await fixture();
		const library = path.join(root, "library.txt");
		await writeFile(library, "shared");
		await symlink(library, path.join(agentDir, "linked.txt"), "file");

		await syncAgentMirror(agentDir, runtimeDir, new Set([WINDOWS_MIRROR_MANIFEST]), { platform: "win32" });

		expect((await lstat(path.join(runtimeDir, "linked.txt"))).isSymbolicLink()).toBe(false);
		expect(await sameIdentity(path.join(runtimeDir, "linked.txt"), library)).toBe(true);
	});

	it("records a missing mutable file without pre-creating either path", async () => {
		const { agentDir, runtimeDir } = await fixture();
		const agentFile = path.join(agentDir, "auth.json");
		const runtimeFile = path.join(runtimeDir, "auth.json");

		await ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true });

		expect(existsSync(agentFile)).toBe(false);
		expect(existsSync(runtimeFile)).toBe(false);
		const manifest = JSON.parse(await readFile(path.join(runtimeDir, WINDOWS_MIRROR_MANIFEST), "utf8"));
		expect(manifest.entries["auth.json"]).toBe("deferred-file");
	});

	it("moves a deferred file into the real agent dir and is idempotent", async () => {
		const { agentDir, runtimeDir } = await fixture();
		const agentFile = path.join(agentDir, "auth.json");
		const runtimeFile = path.join(runtimeDir, "auth.json");
		await ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true });
		await writeFile(runtimeFile, '{"token":"created-by-pi"}');

		const first = await reconcileDeferredRuntimeFiles(runtimeDir, agentDir);
		expect(first.keptNames).toEqual([]);
		expect(first.notices).toHaveLength(1);
		expect(await readFile(agentFile, "utf8")).toBe('{"token":"created-by-pi"}');
		expect(existsSync(runtimeFile)).toBe(false);

		expect(await reconcileDeferredRuntimeFiles(runtimeDir, agentDir)).toEqual({
			notices: [],
			warnings: [],
			keptNames: [],
		});
	});

	it("removes an identical deferred duplicate", async () => {
		const { agentDir, runtimeDir } = await fixture();
		const agentFile = path.join(agentDir, "trust.json");
		const runtimeFile = path.join(runtimeDir, "trust.json");
		await ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true });
		await Promise.all([writeFile(agentFile, "same"), writeFile(runtimeFile, "same")]);

		const result = await reconcileDeferredRuntimeFiles(runtimeDir, agentDir);
		expect(result).toEqual({ notices: [], warnings: [], keptNames: [] });
		expect(existsSync(runtimeFile)).toBe(false);
		expect(await readFile(agentFile, "utf8")).toBe("same");
	});

	it("keeps both sides and warns when concurrent deferred state diverges", async () => {
		const { agentDir, runtimeDir } = await fixture();
		const agentFile = path.join(agentDir, "models-store.json");
		const runtimeFile = path.join(runtimeDir, "models-store.json");
		await ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true });
		await Promise.all([writeFile(agentFile, "first"), writeFile(runtimeFile, "second")]);

		const result = await reconcileDeferredRuntimeFiles(runtimeDir, agentDir);
		expect(result.keptNames).toEqual(["models-store.json"]);
		expect(result.warnings[0]).toContain("both files were kept");
		expect(await readFile(agentFile, "utf8")).toBe("first");
		expect(await readFile(runtimeFile, "utf8")).toBe("second");
	});

	it("validates filesystem identity instead of trusting manifest declarations", async () => {
		const { agentDir, runtimeDir } = await fixture();
		await writeFile(path.join(agentDir, "owned.txt"), "real");
		await syncAgentMirror(agentDir, runtimeDir, new Set([WINDOWS_MIRROR_MANIFEST]), { platform: "win32" });
		await writeFile(path.join(runtimeDir, "forged.txt"), "private");
		const manifestPath = path.join(runtimeDir, WINDOWS_MIRROR_MANIFEST);
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		manifest.entries["forged.txt"] = "hardlink";
		await writeFile(manifestPath, JSON.stringify(manifest));

		const owned = await inspectOwnedMirrorNames(runtimeDir, agentDir);
		expect([...owned]).toEqual(["owned.txt"]);

		await writeFile(manifestPath, "not json");
		expect([...await inspectOwnedMirrorNames(runtimeDir, agentDir)]).toEqual([]);
	});

	it.skipIf(process.platform === "win32" || !existsSync("/dev/shm"))(
		"copies a newly created deferred file safely when reconciliation crosses volumes",
		async () => {
			const agent = await fixture();
			const runtime = await fixture("/dev/shm");
			const agentFile = path.join(agent.agentDir, "auth.json");
			const runtimeFile = path.join(runtime.runtimeDir, "auth.json");
			await ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true });
			await writeFile(runtimeFile, "cross-volume state");

			const result = await reconcileDeferredRuntimeFiles(runtime.runtimeDir, agent.agentDir);

			expect(result.keptNames).toEqual([]);
			expect(await readFile(agentFile, "utf8")).toBe("cross-volume state");
			expect(existsSync(runtimeFile)).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32" || !existsSync("/dev/shm"))(
		"fails clearly instead of copying an existing cross-volume file",
		async () => {
			const source = await fixture("/dev/shm");
			const destination = await fixture();
			const agentFile = path.join(source.agentDir, "auth.json");
			const runtimeFile = path.join(destination.runtimeDir, "auth.json");
			await writeFile(agentFile, "state");

			await expect(
				ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true }),
			).rejects.toThrow(RuntimeMaterializationError);
			await expect(
				ensureSharedRuntimeFile(agentFile, runtimeFile, { platform: "win32", deferWhenMissing: true }),
			).rejects.toThrow("PI_PROFILE_SWITCH_DIR");
			expect(existsSync(runtimeFile)).toBe(false);
		},
	);
});
