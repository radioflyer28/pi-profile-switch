/**
 * ProfileCatalog: reads profile definitions from the global catalog
 * (`~/.pi-profile-switch/profiles/`, or `PI_PROFILE_SWITCH_DIR/profiles/`)
 * and, for trusted projects, the project catalog (`<projectDir>/.pi/profiles/`).
 *
 * Invariants:
 * - Each profile is stored in a separate `<name>.json` file.
 * - The built-in `default` profile never exists as a file and cannot be
 *   defined in any catalog (`default.json` is a hard error).
 * - Profile names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
 * - A project profile with the same name fully replaces the global
 *   definition (no merge, no inheritance); removing the project file
 *   immediately reveals the global one.
 * - The caller passes `projectDir` only when the resolver's trust check
 *   passed — an untrusted project's catalog is never read.
 * - A malformed profile file fails loudly (CatalogError) with its file path
 *   rather than silently starting unfiltered.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { getGlobalProfilesDir } from "./workspace.ts";
import { isRecord, readJsonFile } from "./json-file.ts";

export const DEFAULT_PROFILE_NAME = "default";
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ProfileModel {
	provider: string;
	id: string;
	thinkingLevel?: string;
}

/** A profile definition as stored in a catalog file. All fields optional:
 *  undeclared fields leave Pi's behavior untouched (PRD default-first rule).
 *  Model fields mirror Pi's settings.json keys (defaultProvider/defaultModel/
 *  defaultThinkingLevel) for direct compatibility. */
export interface ChildProfileDefinition {
	isolation: "process" | "session";
	context: {
		project: boolean;
		global: boolean;
		projectResources: "deny" | "allow";
	};
}

export interface ProfileDefinition {
	label?: string;
	description?: string;
	skills?: string[];
	extensions?: string[];
	mcps?: string[];
	tools?: string[];
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	instructions?: string;
	/** Exact child-launch policy. Omitted profiles retain legacy session-only semantics. */
	child?: ChildProfileDefinition;
}

/** Where a profile's definition came from. */
export type ProfileSource = "builtin" | "global" | "project";

interface CatalogEntry {
	source: "global" | "project";
	definition: ProfileDefinition;
}

export interface ResolvedProfile {
	name: string;
	source: ProfileSource;
	definition: ProfileDefinition;
}

export class CatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogError";
	}
}

function readStringArray(value: unknown, field: string, profileName: string, filePath?: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		const prefix = filePath ? `${filePath}: ` : "";
		throw new CatalogError(`${prefix}profile "${profileName}": "${field}" must be an array of strings`);
	}
	return value as string[];
}

function readOptionalString(value: unknown, field: string, profileName: string, filePath?: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		const prefix = filePath ? `${filePath}: ` : "";
		throw new CatalogError(`${prefix}profile "${profileName}": "${field}" must be a string`);
	}
	return value;
}

function readChildDefinition(value: unknown, profileName: string, filePath?: string): ChildProfileDefinition | undefined {
	if (value === undefined) return undefined;
	const prefix = filePath ? `${filePath}: ` : "";
	if (!isRecord(value)) throw new CatalogError(`${prefix}profile "${profileName}": "child" must be an object`);
	const childKeys = new Set(["isolation", "context"]);
	const unknownChild = Object.keys(value).filter((key) => !childKeys.has(key));
	if (unknownChild.length > 0) throw new CatalogError(`${prefix}profile "${profileName}": unknown child field(s): ${unknownChild.join(", ")}`);
	if (value.isolation !== "process" && value.isolation !== "session") {
		throw new CatalogError(`${prefix}profile "${profileName}": "child.isolation" must be "process" or "session"`);
	}
	if (!isRecord(value.context)) throw new CatalogError(`${prefix}profile "${profileName}": "child.context" must be an object`);
	const contextKeys = new Set(["project", "global", "projectResources"]);
	const unknownContext = Object.keys(value.context).filter((key) => !contextKeys.has(key));
	if (unknownContext.length > 0) throw new CatalogError(`${prefix}profile "${profileName}": unknown child.context field(s): ${unknownContext.join(", ")}`);
	if (typeof value.context.project !== "boolean" || typeof value.context.global !== "boolean") {
		throw new CatalogError(`${prefix}profile "${profileName}": child context project/global must be booleans`);
	}
	if (value.context.projectResources !== "deny" && value.context.projectResources !== "allow") {
		throw new CatalogError(`${prefix}profile "${profileName}": "child.context.projectResources" must be "deny" or "allow"`);
	}
	return {
		isolation: value.isolation,
		context: {
			project: value.context.project,
			global: value.context.global,
			projectResources: value.context.projectResources,
		},
	};
}

/** Parses one raw profile definition; exported for the write-side store
 *  (profile-catalog-store.ts) so anything written is loadable. */
export function parseProfileDefinition(name: string, raw: unknown, filePath?: string): ProfileDefinition {
	if (!isRecord(raw)) {
		const prefix = filePath ? `${filePath}: ` : "";
		throw new CatalogError(`${prefix}profile "${name}" must be an object`);
	}
	const definition: ProfileDefinition = {};
	const label = readOptionalString(raw.label, "label", name, filePath);
	if (label !== undefined) definition.label = label;
	const description = readOptionalString(raw.description, "description", name, filePath);
	if (description !== undefined) definition.description = description;
	for (const field of ["skills", "extensions", "mcps", "tools"] as const) {
		const entries = readStringArray(raw[field], field, name, filePath);
		if (entries !== undefined) definition[field] = entries;
	}
	const defaultProvider = readOptionalString(raw.defaultProvider, "defaultProvider", name, filePath);
	if (defaultProvider !== undefined) definition.defaultProvider = defaultProvider;
	const defaultModel = readOptionalString(raw.defaultModel, "defaultModel", name, filePath);
	if (defaultModel !== undefined) definition.defaultModel = defaultModel;
	const defaultThinkingLevel = readOptionalString(raw.defaultThinkingLevel, "defaultThinkingLevel", name, filePath);
	if (defaultThinkingLevel !== undefined) definition.defaultThinkingLevel = defaultThinkingLevel;
	const instructions = readOptionalString(raw.instructions, "instructions", name, filePath);
	if (instructions !== undefined) definition.instructions = instructions;
	const child = readChildDefinition(raw.child, name, filePath);
	if (child !== undefined) definition.child = child;
	return definition;
}

/** Reads one catalog directory; missing directory → empty map, malformed file → CatalogError. */
export async function loadCatalogDirectory(dirPath: string): Promise<Map<string, ProfileDefinition>> {
	let entries: Dirent[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return new Map();
		}
		throw error;
	}

	// Filter to .json files and sort alphabetically by file name
	const jsonEntries = entries.filter((entry) => entry.name.endsWith(".json"));
	jsonEntries.sort((a, b) => a.name.localeCompare(b.name));

	const profiles = new Map<string, ProfileDefinition>();
	for (const entry of jsonEntries) {
		const fullPath = path.join(dirPath, entry.name);
		let isFile = entry.isFile();
		if (!isFile && entry.isSymbolicLink()) {
			try {
				const st = await stat(fullPath);
				isFile = st.isFile();
			} catch {
				continue;
			}
		}
		if (!isFile) continue;

		const profileName = entry.name.slice(0, -".json".length);
		if (profileName === DEFAULT_PROFILE_NAME) {
			throw new CatalogError(
				`${fullPath}: "${DEFAULT_PROFILE_NAME}" is built in and must not be defined in the catalog`,
			);
		}
		if (!PROFILE_NAME_PATTERN.test(profileName)) {
			throw new CatalogError(
				`${fullPath}: invalid profile name "${profileName}" (must match ${PROFILE_NAME_PATTERN})`,
			);
		}

		const result = await readJsonFile(fullPath);
		if (!result.ok) {
			throw new CatalogError(`invalid JSON in ${fullPath}`);
		}
		const parsed = result.value;
		if (!isRecord(parsed)) {
			throw new CatalogError(`${fullPath}: profile definition must be an object`);
		}
		profiles.set(profileName, parseProfileDefinition(profileName, parsed, fullPath));
	}
	return profiles;
}

export class ProfileCatalog {
	readonly #profiles: ReadonlyMap<string, CatalogEntry>;

	private constructor(profiles: ReadonlyMap<string, CatalogEntry>) {
		this.#profiles = profiles;
	}

	/**
	 * Reads the global catalog, plus the project catalog when `projectDir` is
	 * given (trusted projects only — the caller gates on the trust check).
	 * Missing directories mean an empty catalog; malformed content throws
	 * CatalogError. Project entries replace same-name global entries.
	 */
	static async load(_agentDir: string, options?: { projectDir?: string }): Promise<ProfileCatalog> {
		return ProfileCatalog.loadFromDirectories(
			getGlobalProfilesDir(),
			options?.projectDir === undefined ? undefined : path.join(options.projectDir, ".pi", "profiles"),
		);
	}

	/** Explicit-directory variant for side-effect-free SDK consumers and tests. */
	static async loadFromDirectories(globalProfilesDir: string, projectProfilesDir?: string): Promise<ProfileCatalog> {
		const globalProfiles = await loadCatalogDirectory(globalProfilesDir);
		const profiles = new Map<string, CatalogEntry>();
		for (const [name, definition] of globalProfiles) {
			profiles.set(name, { source: "global", definition });
		}
		if (projectProfilesDir !== undefined) {
			const projectProfiles = await loadCatalogDirectory(projectProfilesDir);
			for (const [name, definition] of projectProfiles) {
				profiles.set(name, { source: "project", definition });
			}
		}
		return new ProfileCatalog(profiles);
	}

	/** Resolves a profile by name. `default` always resolves to the built-in
	 *  full-resource profile; unknown names return undefined. */
	resolve(name: string): ResolvedProfile | undefined {
		if (name === DEFAULT_PROFILE_NAME) {
			return { name: DEFAULT_PROFILE_NAME, source: "builtin", definition: {} };
		}
		const entry = this.#profiles.get(name);
		return entry === undefined ? undefined : { name, source: entry.source, definition: entry.definition };
	}

	/** Lists the built-in default first, then profiles in file order (global
	 *  entries in global alphabetical order, project-only names appended after in alphabetical order). */
	list(): ResolvedProfile[] {
		return [
			this.resolve(DEFAULT_PROFILE_NAME)!,
			...[...this.#profiles.keys()].map((name) => this.resolve(name)!),
		];
	}
}
