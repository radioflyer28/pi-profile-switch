import { chmod, lstat, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateRuntimeDir, writeRuntimeFiles } from "../src/settings-generator.ts";
import { defaultPlan } from "../src/profile-resolver.ts";
import { switchProfile, SwitchError } from "../src/switching/switch-profile.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;
let savedHome: string | undefined;
let runtimeDir: string;

beforeEach(async () => {
	fixture = await createPiFixture();
	savedHome = process.env.HOME;
	process.env.HOME = fixture.root;
	runtimeDir = (
		await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir })
	).runtimeDir;
});

afterEach(async () => {
	process.env.HOME = savedHome;
	await rm(fixture.root, { recursive: true, force: true });
});

const deps = (overrides?: Partial<Parameters<typeof switchProfile>[1]>) => ({
	runtimeDir,
	realAgentDir: fixture.agentDir,
	cwd: fixture.cwd,
	getAllTools: () => ["read", "bash", "grep"].map((name) => ({ name })),
	waitForIdle: async () => {},
	reload: async () => {},
	// Tests simulate the reload having re-executed extensions (context stale).
	assertStale: () => {
		throw new Error("stale");
	},
	...overrides,
});

async function writeCatalog(profiles: Record<string, unknown>): Promise<void> {
	const dir = path.join(fixture.profileSwitchDir, "profiles");
	await mkdir(dir, { recursive: true });
	for (const [name, definition] of Object.entries(profiles)) {
		await writeFile(path.join(dir, `${name}.json`), JSON.stringify(definition));
	}
}

async function readPlanFile(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path.join(runtimeDir, "pi-profile.json"), "utf8"));
}

describe("switchProfile", () => {
	it("rewrites the runtime files for the target profile and marks the plan for persistence", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });

		const result = await switchProfile("impl", deps());

		expect(result.profile).toBe("impl");
		const plan = await readPlanFile();
		expect(plan.profile).toBe("impl");
		expect(plan.switchedFrom).toBe("default");
		expect(plan.persistSelection).toBe(true);
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([path.join(fixture.agentDir, "skills", "alpha-skill", "SKILL.md")]);
		expect(settings.defaultProjectTrust).toBe("never");
	});

	it("waits for the agent to be idle before touching the runtime files", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		let releaseIdle!: () => void;
		const idleGate = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const original = await readFile(path.join(runtimeDir, "settings.json"), "utf8");

		const pending = switchProfile("impl", deps({ waitForIdle: () => idleGate }));
		await new Promise((resolve) => setTimeout(resolve, 60));
		const observed = (await readFile(path.join(runtimeDir, "settings.json"), "utf8")) === original ? "untouched" : "rewritten";
		releaseIdle();
		await pending;

		expect(observed).toBe("untouched");
	});

	it("leaves the runtime untouched when the target fails to resolve", async () => {
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		const originalPlan = await readPlanFile();

		await expect(switchProfile("ghost", deps())).rejects.toThrow(/unknown profile/);

		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect(await readPlanFile()).toEqual(originalPlan);
	});

	it("restores the snapshot and reloads again when reload fails", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};

		await expect(switchProfile("impl", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect((await readPlanFile()).profile).toBe("default");
	});

	it("rolls back when Pi silently skips the reload (context never goes stale)", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		const originalSettings = await readFile(path.join(runtimeDir, "settings.json"), "utf8");
		let reloads = 0;

		await expect(
			switchProfile(
				"impl",
				deps({
					reload: async () => {
						reloads += 1;
					},
					assertStale: () => {}, // still valid: the reload never re-executed extensions
				}),
			),
		).rejects.toThrow(/did not run the reload/);

		expect(reloads).toBe(2); // the restore reload
		expect(await readFile(path.join(runtimeDir, "settings.json"), "utf8")).toBe(originalSettings);
		expect((await readPlanFile()).profile).toBe("default");
	});

	it("restores mcp.json, APPEND_SYSTEM.md, and trust.json to the pre-switch state when the reload fails", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalExtension(fixture, "pi-mcp-adapter");
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "linear" } } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ projects: {} }));
		await writeCatalog({
			impl: { skills: ["alpha-skill"], extensions: ["pi-mcp-adapter"], mcps: ["github"], instructions: "Be terse." },
		});
		// Re-apply the default plan so the runtime dir reflects a real default
		// launch: mcp.json + trust.json linked, no APPEND_SYSTEM.md.
		await writeRuntimeFiles(runtimeDir, defaultPlan(), { agentDir: fixture.agentDir });
		const agentMcp = path.join(fixture.agentDir, "mcp.json");
		const agentTrust = path.join(fixture.agentDir, "trust.json");
		expect((await lstat(path.join(runtimeDir, "mcp.json"))).isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "mcp.json"))).toBe(agentMcp);
		expect(await readlink(path.join(runtimeDir, "trust.json"))).toBe(agentTrust);
		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};

		await expect(switchProfile("impl", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		expect(reloads).toBe(2);
		// The switch rewrote all three (filtered mcp.json, APPEND_SYSTEM.md
		// created, trust.json removed); the rollback must leave them in the
		// pre-switch state, not the target profile's.
		const mcpStat = await lstat(path.join(runtimeDir, "mcp.json"));
		expect(mcpStat.isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "mcp.json"))).toBe(agentMcp);
		const trustStat = await lstat(path.join(runtimeDir, "trust.json"));
		expect(trustStat.isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "trust.json"))).toBe(agentTrust);
		await expect(lstat(path.join(runtimeDir, "APPEND_SYSTEM.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("restores Windows hard-link identity when a switch fails", async () => {
		await addGlobalExtension(fixture, "pi-mcp-adapter");
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "linear" } } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ projects: {} }));
		await writeCatalog({ impl: { extensions: ["pi-mcp-adapter"], mcps: ["github"] } });
		runtimeDir = (
			await generateRuntimeDir(defaultPlan(), { agentDir: fixture.agentDir, platform: "win32" })
		).runtimeDir;

		let reloads = 0;
		await expect(
			switchProfile("impl", deps({
				platform: "win32",
				reload: async () => {
					reloads += 1;
					if (reloads === 1) throw new Error("boom");
				},
			})),
		).rejects.toThrow(/restored the previous settings/);

		for (const name of ["mcp.json", "trust.json"]) {
			const [runtimeInfo, agentInfo] = await Promise.all([
				stat(path.join(runtimeDir, name)),
				stat(path.join(fixture.agentDir, name)),
			]);
			expect(runtimeInfo.ino).toBe(agentInfo.ino);
			expect(runtimeInfo.dev).toBe(agentInfo.dev);
		}
	});

	it("restores a snapshotted regular file exactly, even after the switch replaced it with a symlink or deleted it", async () => {
		await addGlobalExtension(fixture, "pi-mcp-adapter");
		await writeFile(
			path.join(fixture.agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { github: { url: "https://x" }, linear: { command: "linear" } } }),
		);
		await writeFile(path.join(fixture.agentDir, "trust.json"), JSON.stringify({ projects: {} }));
		await writeCatalog({
			impl: { extensions: ["pi-mcp-adapter"], mcps: ["github"], instructions: "Be terse." },
		});
		// Clean switch to the named profile: mcp.json is a filtered regular
		// file, APPEND_SYSTEM.md carries the profile instructions.
		await switchProfile("impl", deps());
		const filteredMcp = await readFile(path.join(runtimeDir, "mcp.json"), "utf8");
		const realMcpBefore = await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8");
		let reloads = 0;
		let trustLinkCreated = false;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) {
				// Observe the generator's mid-switch state before failing: the
				// trust.json link is kept in place for every profile.
				trustLinkCreated = (await lstat(path.join(runtimeDir, "trust.json"))).isSymbolicLink();
				throw new Error("boom");
			}
		};

		await expect(switchProfile("default", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		// The default profile's generator swapped mcp.json for a symlink to the
		// real config and deleted APPEND_SYSTEM.md; rollback must replace the mcp
		// link — never writeFile through it, which would clobber the user's real
		// mcp.json — and recreate the deleted file with the exact content. The
		// trust.json link is profile-independent, so it survives untouched.
		expect(await readFile(path.join(fixture.agentDir, "mcp.json"), "utf8")).toBe(realMcpBefore);
		const mcpStat = await lstat(path.join(runtimeDir, "mcp.json"));
		expect(mcpStat.isSymbolicLink()).toBe(false);
		expect(mcpStat.isFile()).toBe(true);
		expect(await readFile(path.join(runtimeDir, "mcp.json"), "utf8")).toBe(filteredMcp);
		expect(await readFile(path.join(runtimeDir, "APPEND_SYSTEM.md"), "utf8")).toBe("Be terse.");
		expect(trustLinkCreated).toBe(true);
		const trustStat = await lstat(path.join(runtimeDir, "trust.json"));
		expect(trustStat.isSymbolicLink()).toBe(true);
		expect(await readlink(path.join(runtimeDir, "trust.json"))).toBe(path.join(fixture.agentDir, "trust.json"));
	});

	it("restores the pre-switch file mode, not just the content", async () => {
		await writeCatalog({ impl: { instructions: "Be terse." } });
		await switchProfile("impl", deps());
		const appendPath = path.join(runtimeDir, "APPEND_SYSTEM.md");
		await chmod(appendPath, 0o600);

		let reloads = 0;
		const reload = async () => {
			reloads += 1;
			if (reloads === 1) throw new Error("boom");
		};
		await expect(switchProfile("default", deps({ reload }))).rejects.toThrow(/restored the previous settings/);

		// The failed switch deleted APPEND_SYSTEM.md; rollback recreates it
		// with the snapshot's content AND permission bits (writeFile alone
		// would recreate it with the umask default, widening 0600 to 0644).
		expect(await readFile(appendPath, "utf8")).toBe("Be terse.");
		expect((await lstat(appendPath)).mode & 0o777).toBe(0o600);
	});

	it("reload re-resolves the current profile without a switch marker and keeps its persistence", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		await switchProfile("impl", deps());

		const result = await switchProfile(undefined, deps(), { reloadCurrent: true });

		expect(result.profile).toBe("impl");
		const plan = await readPlanFile();
		expect(plan.switchedFrom).toBeUndefined();
		expect(plan.persistSelection).toBe(true);
	});

	it("reload of a transient launch selection stays transient", async () => {
		// Launch plans have no persistSelection (the CLI selection is transient).
		expect((await readPlanFile()).persistSelection).toBeUndefined();
		await writeCatalog({});

		const result = await switchProfile(undefined, deps(), { reloadCurrent: true });

		expect(result.profile).toBe("default");
		expect((await readPlanFile()).persistSelection).toBe(false);
	});

	it("re-resolves at switch time, so catalog edits are picked up", async () => {
		await addGlobalSkill(fixture, "alpha-skill");
		await addGlobalSkill(fixture, "beta-skill");
		await writeCatalog({ impl: { skills: ["alpha-skill"] } });
		await mkdir(path.join(fixture.agentDir, "skills"), { recursive: true });
		await switchProfile("impl", deps());
		// The profile definition changes after activation; reload propagates it.
		await writeCatalog({ impl: { skills: ["beta-skill"] } });

		await switchProfile(undefined, deps(), { reloadCurrent: true });

		const runtimeDir = deps().runtimeDir;
		const settings = JSON.parse(await readFile(path.join(runtimeDir, "settings.json"), "utf8"));
		expect(settings.skills).toEqual([
			path.join(fixture.agentDir, "skills", "beta-skill", "SKILL.md"),
			`-${path.join(runtimeDir, "skills", "alpha-skill", "SKILL.md")}`,
		]);
	});
});
