import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNamedChildProfile } from "../src/child-profile-resolver.ts";
import { addGlobalExtension, addGlobalSkill, createPiFixture, listFiles, type PiFixture } from "./helpers/pi-fixture.ts";

let fixture: PiFixture;

beforeEach(async () => {
	fixture = await createPiFixture();
	await mkdir(path.join(fixture.profileSwitchDir, "profiles"), { recursive: true });
});

afterEach(async () => {
	await rm(fixture.root, { recursive: true, force: true });
});

async function writeProfile(name: string, value: unknown): Promise<void> {
	await writeFile(path.join(fixture.profileSwitchDir, "profiles", `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function child(overrides: Record<string, unknown> = {}) {
	return {
		tools: ["read", "grep"],
		skills: [],
		extensions: [],
		child: {
			isolation: "process",
			context: { project: true, global: false, projectResources: "deny" },
		},
		...overrides,
	};
}

async function resolve(name: string, extra: Partial<Parameters<typeof resolveNamedChildProfile>[0]> = {}) {
	return resolveNamedChildProfile({
		name,
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		profilesDir: path.join(fixture.profileSwitchDir, "profiles"),
		...extra,
	});
}

describe("resolveNamedChildProfile", () => {
	it("returns a deeply immutable exact contract with content identities and no writes", async () => {
		await addGlobalSkill(fixture, "review");
		await addGlobalExtension(fixture, "guard");
		await writeProfile("lean", child({ skills: ["review"], extensions: ["guard"], instructions: "Review only." }));
		const before = await listFiles(fixture.root);

		const contract = await resolve("lean");
		const after = await listFiles(fixture.root);

		expect(after).toEqual(before);
		expect(contract.name).toBe("lean");
		expect(contract.mode).toBe("replace");
		expect(contract.declarations).toEqual({ tools: "explicit", skills: "explicit", extensions: "explicit" });
		expect(contract.resources.tools.map((tool) => tool.name)).toEqual(["read", "grep"]);
		expect(contract.resources.skills[0]?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.resources.extensions[0]?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.profileContentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(contract.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.resources.skills)).toBe(true);
	});

	it("distinguishes omission from explicit empty arrays", async () => {
		await writeProfile("omitted", {
			tools: [],
			skills: [],
			child: { isolation: "process", context: { project: false, global: false, projectResources: "deny" } },
		});
		await writeProfile("empty", child({ tools: [], skills: [], extensions: [] }));

		await expect(resolve("omitted")).rejects.toThrow(/explicitly declare "extensions"/);
		await expect(resolve("empty")).resolves.toMatchObject({ resources: { tools: [], skills: [], extensions: [] } });
	});

	it("fails closed for unknown profiles and resources", async () => {
		await expect(resolve("missing")).rejects.toThrow(/unknown child profile/);
		await writeProfile("bad-skill", child({ skills: ["does-not-exist"] }));
		await expect(resolve("bad-skill")).rejects.toThrow(/does-not-exist/);
		await writeProfile("bad-extension", child({ extensions: [path.join(fixture.root, "missing-extension.ts")] }));
		await expect(resolve("bad-extension")).rejects.toThrow(/extension path not found/);
	});

	it("resolves two profiles concurrently without active-profile, environment, or contract leakage", async () => {
		await writeProfile("reader", child({ tools: ["read"], child: { isolation: "session", context: { project: false, global: false, projectResources: "deny" } } }));
		await writeProfile("searcher", child({ tools: ["grep", "find"], child: { isolation: "process", context: { project: true, global: false, projectResources: "deny" } } }));
		const savedOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "parent-sentinel";
		const observed: Array<string | undefined> = [];
		const watcher = setInterval(() => observed.push(process.env.PI_OFFLINE), 0);
		try {
			const [reader, searcher] = await Promise.all([resolve("reader"), resolve("searcher")]);
			expect(reader.resources.tools.map((tool) => tool.name)).toEqual(["read"]);
			expect(searcher.resources.tools.map((tool) => tool.name)).toEqual(["grep", "find"]);
			expect(reader.isolation).toBe("session");
			expect(searcher.isolation).toBe("process");
			expect(reader.digest).not.toBe(searcher.digest);
			expect(process.env.PI_OFFLINE).toBe("parent-sentinel");
			expect(observed.every((value) => value === "parent-sentinel")).toBe(true);
		} finally {
			clearInterval(watcher);
			if (savedOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = savedOffline;
		}
	});

	it("requires caller-established trust before project resources or project profiles enter resolution", async () => {
		const projectSkill = path.join(fixture.cwd, ".pi", "skills", "project-review");
		await mkdir(projectSkill, { recursive: true });
		await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: project-review\ndescription: project skill\n---\n");
		await writeProfile("deny-project", child({ skills: ["project-review"] }));
		await writeProfile("allow-project", child({
			skills: ["project-review"],
			child: { isolation: "process", context: { project: true, global: false, projectResources: "allow" } },
		}));

		await expect(resolve("deny-project", { projectTrusted: true })).rejects.toThrow(/project-review/);
		await expect(resolve("allow-project")).rejects.toThrow(/did not establish project trust/);
		const allowed = await resolve("allow-project", { projectTrusted: true });
		expect(allowed.resources.skills.map((skill) => skill.name)).toEqual(["project-review"]);
	});

	it("changes the effective digest when selected resource content changes", async () => {
		await addGlobalSkill(fixture, "review");
		await writeProfile("lean", child({ skills: ["review"] }));
		const first = await resolve("lean");
		const skillPath = path.join(fixture.agentDir, "skills", "review", "SKILL.md");
		await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\nchanged\n`);
		const second = await resolve("lean");
		expect(second.resources.skills[0]?.contentDigest).not.toBe(first.resources.skills[0]?.contentDigest);
		expect(second.digest).not.toBe(first.digest);
	});
});
