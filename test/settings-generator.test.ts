import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultPlan } from "../src/profile-resolver.ts";
import { WINDOWS_MIRROR_MANIFEST } from "../src/runtime-mirror.ts";
import { generateRuntimeDir, writeRuntimeFiles } from "../src/settings-generator.ts";
import { createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

describe("generateRuntimeDir (default profile)", () => {
	it("preserves user settings keys and re-includes the real agent dir's resource dirs", async () => {
		const settings = { defaultModel: "claude-sonnet-4-5", theme: "dark", customKey: { nested: true } };
		await writeFile(path.join(fixture.agentDir, "settings.json"), JSON.stringify(settings));
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const generated = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));

		expect(generated.defaultModel).toBe("claude-sonnet-4-5");
		expect(generated.customKey).toEqual({ nested: true });
		// The discovery root moved with PI_CODING_AGENT_DIR, so the real
		// agent dir's skills dir must be re-included explicitly.
		expect(generated.skills).toContain(path.join(fixture.agentDir, "skills"));
	});

	it("writes an empty settings object when the user has none", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"))).toEqual({});
	});

	it("does not set defaultProjectTrust for the default profile", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const settings = JSON.parse(await readFile(path.join(result.runtimeDir, "settings.json"), "utf8"));
		expect(settings.defaultProjectTrust).toBeUndefined();
	});

	it("symlinks trust/auth/models state back to the real agent dir", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "trust.json"), "{}");
		await writeFile(path.join(fixture.agentDir, "models.json"), "{}");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "trust.json", "models.json"]) {
			expect(await realpath(path.join(result.runtimeDir, name))).toBe(await realpath(path.join(fixture.agentDir, name)));
		}
	});

	it("points PI_CODING_AGENT_DIR at the runtime dir and symlinks sessions without overriding session dir", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(result.env.PI_CODING_AGENT_DIR).toBe(result.runtimeDir);
		expect(result.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
		expect(await realpath(path.join(result.runtimeDir, "sessions"))).toBe(
			await realpath(path.join(fixture.agentDir, "sessions")),
		);
	});

	it("ensures agentDir/sessions exists and is symlinked even if not initially present", async () => {
		expect(existsSync(path.join(fixture.agentDir, "sessions"))).toBe(false);
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		expect(existsSync(path.join(fixture.agentDir, "sessions"))).toBe(true);
		expect(await realpath(path.join(result.runtimeDir, "sessions"))).toBe(
			await realpath(path.join(fixture.agentDir, "sessions")),
		);
	});

	it("creates a unique runtime dir per launch under the instances root", async () => {
		const first = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const second = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		const root = path.join(fixture.profileSwitchDir, "instances");
		for (const result of [first, second]) {
			expect(path.dirname(result.runtimeDir)).toBe(root);
			expect(path.basename(result.runtimeDir).startsWith("launch-")).toBe(true);
		}
		expect(first.runtimeDir).not.toBe(second.runtimeDir);
	});

	it("seeds the real agent dir's missions store and links it into the instance", async () => {
		expect(existsSync(path.join(fixture.agentDir, "missions"))).toBe(false);

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		expect(existsSync(path.join(fixture.agentDir, "missions"))).toBe(true);
		expect(await realpath(path.join(result.runtimeDir, "missions"))).toBe(
			await realpath(path.join(fixture.agentDir, "missions")),
		);
	});

	it("links an existing missions store without touching its content", async () => {
		const store = path.join(fixture.agentDir, "missions", "projects", "abc");
		await mkdir(store, { recursive: true });
		const record = path.join(store, "mission.json");
		await writeFile(record, "{}");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		expect(await realpath(path.join(result.runtimeDir, "missions"))).toBe(
			await realpath(path.join(fixture.agentDir, "missions")),
		);
		expect(await readFile(record, "utf8")).toBe("{}");
	});

	it("links the runtime state files Pi creates, even before they exist", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "models-store.json"]) {
			const linkPath = path.join(result.runtimeDir, name);
			expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
			expect(await readlink(linkPath)).toBe(path.join(fixture.agentDir, name));
			// Deliberately dangling: the content is Pi's to create, not pi-profile's.
			expect(existsSync(path.join(fixture.agentDir, name))).toBe(false);
		}
	});

	it("routes writes through the seeded links into the real agent dir", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		await writeFile(path.join(result.runtimeDir, "auth.json"), "{}");

		expect(await readFile(path.join(fixture.agentDir, "auth.json"), "utf8")).toBe("{}");
		expect((await lstat(path.join(result.runtimeDir, "auth.json"))).isSymbolicLink()).toBe(true);
	});

	it("links an existing state file to the real one", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), '{"provider":{}}');

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		const linkPath = path.join(result.runtimeDir, "auth.json");
		expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await realpath(linkPath)).toBe(await realpath(path.join(fixture.agentDir, "auth.json")));
	});

	it("uses hard links and deferred files for Windows state without pre-creating formats", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), '{"provider":{}}');
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir, platform: "win32" });

		const [agentAuth, runtimeAuth] = await Promise.all([
			stat(path.join(fixture.agentDir, "auth.json")),
			stat(path.join(result.runtimeDir, "auth.json")),
		]);
		expect(runtimeAuth.ino).toBe(agentAuth.ino);
		expect(runtimeAuth.dev).toBe(agentAuth.dev);
		expect(existsSync(path.join(fixture.agentDir, "models-store.json"))).toBe(false);
		expect(existsSync(path.join(result.runtimeDir, "models-store.json"))).toBe(false);
		const manifest = JSON.parse(await readFile(path.join(result.runtimeDir, WINDOWS_MIRROR_MANIFEST), "utf8"));
		expect(manifest.entries["auth.json"]).toBe("hardlink");
		expect(manifest.entries["models-store.json"]).toBe("deferred-file");
		expect(manifest.entries["trust.json"]).toBe("deferred-file");
	});

	it("keeps Windows hard-link identity when the runtime dir is rewritten in place", async () => {
		await writeFile(path.join(fixture.agentDir, "auth.json"), "{}");
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir, platform: "win32" });
		await writeRuntimeFiles(result.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir, platform: "win32" });

		const [agentAuth, runtimeAuth] = await Promise.all([
			stat(path.join(fixture.agentDir, "auth.json")),
			stat(path.join(result.runtimeDir, "auth.json")),
		]);
		expect(runtimeAuth.ino).toBe(agentAuth.ino);
		expect(runtimeAuth.dev).toBe(agentAuth.dev);
	});

	it("keeps the seeded links when the runtime dir is rewritten in place", async () => {
		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });

		await writeRuntimeFiles(result.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });

		for (const name of ["auth.json", "models-store.json"]) {
			expect((await lstat(path.join(result.runtimeDir, name))).isSymbolicLink()).toBe(true);
		}
	});

	it("cleans up dangling symlinks when the runtime dir is rewritten in place (switch path)", async () => {
		const tempFile = path.join(fixture.agentDir, "temp-file.txt");
		await writeFile(tempFile, "hello");

		const result = await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir });
		const linkedPath = path.join(result.runtimeDir, "temp-file.txt");
		expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);

		// Delete the source and rewrite the SAME runtime dir (what an in-session
		// switch does: PI_CODING_AGENT_DIR cannot move).
		await rm(tempFile);
		await writeRuntimeFiles(result.runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });
		await expect(lstat(linkedPath)).rejects.toThrow();
	});
});
