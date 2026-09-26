import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { discoverLauncherResources } from "./launcher/discovery.ts";
import type { LauncherContext } from "./launcher/initial-profile.ts";
import { ProfileCatalog, type ProfileModel, type ResolvedProfile } from "./profile-catalog.ts";
import { ActivationError, BUILTIN_TOOL_NAMES, resolveProfile } from "./profile-resolver.ts";
import { getGlobalProfilesDir } from "./workspace.ts";

export const CHILD_PROFILE_CONTRACT_VERSION = 1 as const;
export const PI_PROFILE_SWITCH_PROTOTYPE_VERSION = "0.9.2";

type Sha256 = `sha256:${string}`;

export interface ResolvedChildProfileV1 {
	version: typeof CHILD_PROFILE_CONTRACT_VERSION;
	name: string;
	source: "global" | "project";
	sourcePath: string;
	profileContentDigest: Sha256;
	mode: "replace";
	digest: Sha256;
	isolation: "process" | "session";
	resources: {
		tools: Array<{ name: string; provenance: "builtin" | "declared" }>;
		skills: Array<{
			name: string;
			path: string;
			contentDigest: Sha256;
			provenance: { scope: string; origin: string; source: string };
		}>;
		extensions: Array<{
			id: string;
			path: string;
			contentDigest: Sha256;
			provenance: { origin: "package" | "local" | "path" | "unknown" };
		}>;
	};
	declarations: {
		tools: "explicit";
		skills: "explicit";
		extensions: "explicit";
	};
	context: {
		project: boolean;
		global: boolean;
		projectResources: "deny" | "allow";
	};
	model?: ProfileModel;
	instructions?: string;
	compatibility: {
		profileContract: typeof CHILD_PROFILE_CONTRACT_VERSION;
		piProfileSwitch: string;
		pi?: string;
	};
}

export interface ResolveNamedChildProfileOptions extends LauncherContext {
	name: string;
	/** Explicit catalog root; omission uses the normal pi-profile-switch root. */
	profilesDir?: string;
	projectTrusted?: boolean;
	/** Project profile files are executable-project policy and require a caller-owned trust decision. */
	allowProjectProfiles?: boolean;
	validateModel?: (model: ProfileModel) => Promise<string | undefined>;
	piVersion?: string;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hash(value: string | Buffer): Sha256 {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileIdentity(filePath: string): Promise<{ path: string; contentDigest: Sha256 }> {
	let canonical: string;
	let content: Buffer;
	try {
		[canonical, content] = await Promise.all([realpath(filePath), readFile(filePath)]);
	} catch (error) {
		throw new ActivationError(`child profile resource is unavailable at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { path: canonical, contentDigest: hash(content) };
}

function sourcePath(profile: ResolvedProfile, options: ResolveNamedChildProfileOptions): string {
	if (profile.source === "project") return path.join(options.cwd, ".pi", "profiles", `${profile.name}.json`);
	return path.join(options.profilesDir ?? getGlobalProfilesDir(), `${profile.name}.json`);
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

/**
 * Resolve one named profile into an immutable child launch contract. The
 * function does not activate a profile, create a runtime directory, mutate
 * settings, install packages, reload Pi, or import selected extensions.
 */
export async function resolveNamedChildProfile(options: ResolveNamedChildProfileOptions): Promise<ResolvedChildProfileV1> {
	if (options.name === "default") throw new ActivationError('the built-in "default" profile is not an exact child profile');
	const projectProfilesAllowed = options.allowProjectProfiles === true && options.projectTrusted === true;
	const catalog = options.profilesDir
		? await ProfileCatalog.loadFromDirectories(
			options.profilesDir,
			projectProfilesAllowed ? path.join(options.cwd, ".pi", "profiles") : undefined,
		)
		: await ProfileCatalog.load(options.agentDir, {
			...(projectProfilesAllowed ? { projectDir: options.cwd } : {}),
		});
	const profile = catalog.resolve(options.name);
	if (!profile) throw new ActivationError(`unknown child profile: "${options.name}"`);
	if (profile.source === "builtin") throw new ActivationError('the built-in "default" profile is not an exact child profile');
	const definition = profile.definition;
	if (!definition.child) throw new ActivationError(`profile "${profile.name}" is not child-launch capable: missing "child"`);
	for (const field of ["tools", "skills", "extensions"] as const) {
		if (definition[field] === undefined) {
			throw new ActivationError(`profile "${profile.name}" must explicitly declare "${field}" for child replace mode; use [] for none`);
		}
	}
	if (definition.mcps !== undefined) {
		throw new ActivationError(`profile "${profile.name}" declares "mcps", which the child profile prototype does not support`);
	}
	if (definition.child.context.projectResources === "allow" && options.projectTrusted !== true) {
		throw new ActivationError(`profile "${profile.name}" allows project resources but the caller did not establish project trust`);
	}

	const projectResourcesAllowed = definition.child.context.projectResources === "allow" && options.projectTrusted === true;
	const discovery = await discoverLauncherResources({
		cwd: options.cwd,
		agentDir: options.agentDir,
		projectTrusted: projectResourcesAllowed,
	});
	const plan = await resolveProfile({
		profile,
		skills: discovery.skills,
		extensions: discovery.extensions,
		...(definition.defaultProvider !== undefined ? { validateModel: options.validateModel } : {}),
	});
	if (plan.unmatched?.length) {
		throw new ActivationError(`profile "${profile.name}" has unmatched child resource reference(s): ${plan.unmatched.join(", ")}`);
	}
	for (const reference of definition.tools ?? []) {
		if ((reference.includes("*") || reference.includes("?")) && !(plan.tools ?? []).some((tool) => tool !== reference)) {
			throw new ActivationError(`profile "${profile.name}" has an unmatched child tool glob: ${reference}`);
		}
	}

	const tools = (plan.tools ?? []).map((name) => ({
		name,
		provenance: (BUILTIN_TOOL_NAMES as readonly string[]).includes(name) ? "builtin" as const : "declared" as const,
	}));
	const skills = await Promise.all(plan.skills.map(async (skill) => ({
		name: skill.name,
		...(await fileIdentity(skill.filePath)),
		provenance: { scope: skill.scope, origin: skill.origin, source: skill.source },
	})));
	const extensions = await Promise.all(plan.extensions.map(async (extension) => ({
		id: extension.id,
		...(await fileIdentity(extension.entry)),
		provenance: { origin: extension.origin ?? "unknown" as const },
	})));
	const profileIdentity = await fileIdentity(path.resolve(sourcePath(profile, options)));
	const withoutDigest = {
		version: CHILD_PROFILE_CONTRACT_VERSION,
		name: profile.name,
		source: profile.source,
		sourcePath: profileIdentity.path,
		profileContentDigest: profileIdentity.contentDigest,
		mode: "replace" as const,
		isolation: definition.child.isolation,
		resources: { tools, skills, extensions },
		declarations: { tools: "explicit" as const, skills: "explicit" as const, extensions: "explicit" as const },
		context: { ...definition.child.context },
		...(plan.model ? { model: plan.model } : {}),
		...(plan.instructions !== undefined ? { instructions: plan.instructions } : {}),
		compatibility: {
			profileContract: CHILD_PROFILE_CONTRACT_VERSION,
			piProfileSwitch: PI_PROFILE_SWITCH_PROTOTYPE_VERSION,
			...(options.piVersion ? { pi: options.piVersion } : {}),
		},
	};
	const resolved: ResolvedChildProfileV1 = { ...withoutDigest, digest: hash(stableJson(withoutDigest)) };
	return deepFreeze(resolved);
}
