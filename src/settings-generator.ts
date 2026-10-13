/**
 * SettingsGenerator: materializes an ActivationPlan as a pi-profile-owned
 * runtime directory (ADR-0005).
 *
 * Two entry points:
 * - `generateRuntimeDir` (launcher): create a fresh per-launch runtime dir
 *   under the workspace instances root, write the files, mirror the real
 *   agent dir through the platform backend, derive env.
 * - `writeRuntimeFiles` (in-session switch, ticket 05): rewrite
 *   settings.json + pi-profile.json inside the EXISTING runtime dir (the
 *   running process's PI_CODING_AGENT_DIR cannot move), and transition the
 *   trust.json link to match the new plan's filter mode.
 *
 * For the built-in `default` profile the generated settings preserve the
 * user's global settings untouched and re-include the real agent dir's
 * resource dirs (their discovery root moves with `PI_CODING_AGENT_DIR`), so
 * the spawned pi behaves exactly like native `pi`.
 *
 * For named profiles the generated settings encode the profile's selection
 * over user-scope resources only (see docs/architecture/overview.md):
 * - agentDir-scope resources: additive allowlist paths (the discovery root
 *   moved, so nothing auto-discovered from the real agent dir)
 * - `~/.agents` skills: always auto-discovered, so unselected ones are
 *   force-excluded with `-<path>` entries
 * - packages: user-configured package entries rewritten to object form with
 *   per-type allowlists (unmanaged types keep the user's key or Pi's default)
 * - project-scope resources (project `.pi/skills`, project `.pi/extensions`,
 *   ancestor `.agents/skills`) are never encoded: Pi discovers them natively
 *   whenever the project is trusted, and the profile neither adds nor
 *   excludes them
 * - `defaultProjectTrust: "never"` only suppresses Pi's interactive trust
 *   prompt (a stored decision in the real trust.json still applies); the
 *   project's `.pi/settings.json` is not merged here — Pi reads it natively
 * - unmanaged kinds (prompts, themes) pass through: the user's arrays are
 *   preserved and the real agent dir's prompts/themes dirs re-included
 * - tools/model are written to generated settings (defaultTools,
 *   defaultProvider, defaultModel, defaultThinkingLevel); the launch plan
 *   file feeds the in-pi extension (tools strict allowlist, status)
 *
 * User configuration files are never modified.
 */

import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ActivationError, buildInstanceMcpConfig, mcpReferenceDiagnostics, mcpSourceDiagnostics, mergeResolutionDiagnostics, resolutionDiagnostics, type ActivationPlan } from "./profile-resolver.ts";
import { applySubagentSettings, SubagentSettingsError } from "./subagent-settings.ts";
import { getInstancesRootDir } from "./workspace.ts";
import { isRecord } from "./json-file.ts";
import { loadMergedMcpServers, type MergedMcpResult } from "./mcp-config.ts";
import type { SkillEntry } from "./skill-registry.ts";
import {
	ensureSharedRuntimeFile,
	syncAgentMirror,
	WINDOWS_MIRROR_MANIFEST,
} from "./runtime-mirror.ts";

/** A configured global package and its resolved install/local root. */
export interface ConfiguredPackageRoot {
	/** The source string exactly as written in the user's settings. */
	source: string;
	/** Absolute install/local root; undefined when not resolvable offline. */
	root?: string;
}

/** Full discovery results the generator needs beyond the plan itself:
 *  the complete skill set (for `~/.agents` exclusions) and configured
 *  package roots (for classifying extension entries). */
export interface DiscoveryContext {
	skills: SkillEntry[];
	packages: ConfiguredPackageRoot[];
}

export interface GenerateOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Optional home dir override (useful for testing). */
	homeDir?: string;
	/** Optional trusted project dir. */
	projectDir?: string;
	/** Required for selection plans; unused for the default profile. */
	discovery?: DiscoveryContext;
	/** Test seam; production callers use process.platform. */
	platform?: NodeJS.Platform;
}

export interface GeneratedRuntime {
	/** The generated runtime directory (becomes PI_CODING_AGENT_DIR). */
	runtimeDir: string;
	/** Environment variables for the spawned pi process. */
	env: Record<string, string>;
	/** The user's real agent dir, used for post-child state reconciliation. */
	agentDir: string;
	/** Non-fatal diagnostics carried to the launcher's stderr. */
	warnings: string[];
}

/** Files managed explicitly by pi-profile in runtimeDir; excluded from automatic mirroring. */
export const MANAGED_INSTANCE_FILES = new Set([
	"settings.json",
	"mcp.json",
	"APPEND_SYSTEM.md",
	"pi-profile.json",
	"trust.json",
	"pid",
	"extensions",
	WINDOWS_MIRROR_MANIFEST,
]);

/** State directories that Pi and its extensions resolve under the agent dir,
 *  and which therefore appear at runtime rather than at install time. They are
 *  seeded in the REAL agent dir before mirroring, so the instance gets a
 *  platform directory link instead of a private real directory: state then
 *  lands where native Pi puts it, and third-party records never embed an
 *  instance path (ADR-0010). Adding a name here needs observed evidence that a
 *  package creates that directory under the agent dir; anything unlisted shows
 *  up as an unrecognized entry in the sweep (src/launcher/runtime-cleanup.ts). */
const SEEDED_STATE_DIRS = ["sessions", "missions"] as const;

/** State FILES Pi creates at runtime (same evidence rule as the dirs). They
 *  cannot be created up front — the content is Pi's, not pi-profile's. POSIX
 *  instances get dangling links; Windows records deferred files and reconciles
 *  them after exit or during the next sweep (ADR-0019). */
const SEEDED_STATE_FILES = ["auth.json", "models-store.json"] as const;

/** Resource dirs rooted at the real agent dir, re-included for the default
 *  profile because PI_CODING_AGENT_DIR moves the discovery root. */
const RESOURCE_DIR_KINDS = ["skills", "extensions", "prompts", "themes"] as const;

/** Unmanaged resource dirs re-included for every profile (pi-profile does
 *  not manage prompt templates or themes). */
const UNMANAGED_DIR_KINDS = ["prompts", "themes"] as const;

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function toPosix(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

function tryRealpath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function isUnderPath(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
		return true;
	}
	const normRelative = path.relative(tryRealpath(root), tryRealpath(target));
	return normRelative !== "" && !normRelative.startsWith("..") && !path.isAbsolute(normRelative);
}

/** The HOME-level ~/.agents/skills dir: always auto-discovered by Pi,
 *  unsuppressible via PI_CODING_AGENT_DIR, so it needs exclusion entries. */
function homeAgentsSkillsDir(): string {
	return path.join(process.env.HOME ?? homedir(), ".agents", "skills");
}

/** The user's own skill exclusions and force-inclusions (`!pattern`, `+path`,
 *  `-path`), carried into a named profile's generated settings. Relative
 *  entries resolve against the runtime dir, which mirrors the agent dir, so
/** Splits an entry into its override marker (`!`/`+`/`-`) and target; a plain
 *  additive entry has an empty marker. */
function splitNativeEntry(entry: string): { marker: string; target: string } {
	const first = entry[0];
	const marker = first === "!" || first === "+" || first === "-" ? first : "";
	return { marker, target: marker === "" ? entry : entry.slice(1) };
}

/** Whether a path resolves inside the real agent dir (the mirrored subtree). */
function isUnderAgentDir(target: string, agentDir: string): boolean {
	const rel = path.relative(agentDir, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Maps one native skill entry onto the instance's discovery root.
 *
 *  AgentDir skills are discovered in the instance through the runtime-mirror
 *  symlink, so a relative target that stays under the agent dir keeps its
 *  relative form (it still matches the mirror path's `rel`), while an absolute
 *  override under the agent dir is rewritten to the mirror path. A target that
 *  escapes the agent dir is resolved against the real agent dir and emitted
 *  absolute, because nothing mirrors it and the instance base dir would change
 *  its meaning. `~` targets keep their native spelling (real Pi does not expand
 *  them in override entries); `expandTilde` retains the declared branch's
 *  historical remap. */
function mapNativeSkillEntry(
	entry: string,
	agentDir: string,
	runtimeDir: string,
	expandTilde: boolean,
): string {
	const { marker, target } = splitNativeEntry(entry);
	if (target.startsWith("~")) {
		if (!expandTilde) return entry;
		const expanded = path.join(process.env.HOME ?? homedir(), target.slice(1));
		if (!isUnderAgentDir(expanded, agentDir)) return entry;
		return `${marker}${path.join(runtimeDir, path.relative(agentDir, expanded))}`;
	}
	if (path.isAbsolute(target)) {
		if (marker === "" || !isUnderAgentDir(target, agentDir)) return entry;
		return `${marker}${path.join(runtimeDir, path.relative(agentDir, target))}`;
	}
	// Relative target: keep it when the mirror preserves its relative matching;
	// otherwise resolve it against the real agent dir so its native meaning
	// survives the base-dir move.
	const resolved = path.resolve(agentDir, target);
	if (isUnderAgentDir(resolved, agentDir)) return entry;
	return `${marker}${resolved}`;
}

/** Maps one native extension entry onto the instance's discovery root.
 *
 *  For an omitted extension selection the instance mirrors the real extensions
 *  directory, so the mapping matches the skills kind: a relative target under
 *  the agent dir keeps its relative form (it still matches the mirror path's
 *  `rel`), an absolute override under the agent dir is rewritten to the mirror
 *  path, and a target that escapes the agent dir is resolved against the real
 *  agent dir. `builtin:` controls, `~` targets, and marker-less globs keep
 *  their native spelling — Pi's basename matching and its marker-less include
 *  filters over plain entries must stay intact. */
function mapNativeExtensionEntry(entry: string, agentDir: string, runtimeDir: string): string {
	const { target } = splitNativeEntry(entry);
	if (target.startsWith("builtin:")) return entry;
	return mapNativeSkillEntry(entry, agentDir, runtimeDir, false);
}

/** The `-<path>` force-exclusion for one resolved extension entry, matching
 *  the path Pi discovers at runtime under the mirrored extensions directory.
 *  Package extensions are encoded in their package's filter instead. */
function extensionExclusionEntry(
	extension: { entry: string },
	agentDir: string,
	runtimeDir: string,
): string {
	if (isUnderPath(extension.entry, agentDir)) {
		return `-${path.join(runtimeDir, path.relative(agentDir, extension.entry))}`;
	}
	return `-${extension.entry}`;
}

/** The user's own skill overrides (`!pattern`, `+path`, `-path`), carried into
 *  a declared profile's generated settings. Relative entries resolve against
 *  the runtime dir, which mirrors the agent dir, so they pass through
 *  unchanged. An absolute (or, per the declared branch's historical mapping,
 *  `~`) `+`/`-`/`!` target under the agent dir is rewritten to its runtime
 *  mirror path. Plain additive includes are NOT carried: a declared selection
 *  must not re-add unrelated native paths. */
function userSkillExclusions(userSkills: unknown, agentDir: string, runtimeDir: string): string[] {
	if (!Array.isArray(userSkills)) return [];
	return userSkills
		.filter(
			(entry): entry is string =>
				typeof entry === "string" &&
				(entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")),
		)
		.map((entry) => mapNativeSkillEntry(entry, agentDir, runtimeDir, true));
}

/** Native-base (undeclared) mapping: absolute targets only. Real Pi treats a
 *  `~` override as a no-op, so rewriting it would newly change native meaning. */
function mapNativeSkillEntryNative(entry: string, agentDir: string, runtimeDir: string): string {
	return mapNativeSkillEntry(entry, agentDir, runtimeDir, false);
}

/** The `-<path>` force-exclusions for one resolved skill entry, covering both
 *  lexical routes Pi can discover it under: agentDir skills surface through the
 *  runtime-mirror symlink, and a native plain include may also load the file at
 *  its real absolute path. Emitting both keeps an overlay disable effective
 *  without hiding unrelated resources; an unmatched `-` entry is inert. Package
 *  skills are encoded in their package's filter instead. */
function skillExclusionEntries(skill: SkillEntry, agentDir: string, runtimeDir: string): string[] {
	if (isUnderPath(skill.filePath, agentDir)) {
		const mirror = `-${path.join(runtimeDir, path.relative(agentDir, skill.filePath))}`;
		return [mirror, `-${skill.filePath}`];
	}
	return [`-${skill.filePath}`];
}

/** The user's native built-in extension controls (`!builtin:*`,
 *  `+builtin:<name>`, `-builtin:<name>`), as written. Their identities and
 *  syntax are Pi's, so they are carried verbatim rather than reconstructed. */
function nativeBuiltinControls(userExtensions: unknown): string[] {
	if (!Array.isArray(userExtensions)) return [];
	return userExtensions.filter(
		(entry): entry is string => typeof entry === "string" && /^[!+-]builtin:/.test(entry),
	);
}

/** Appends overlay force-exclusions to a package kind's native filter. An
 *  absent native filter becomes just the exclusions; an existing explicitly
 *  empty filter stays empty (nothing was loadable to exclude). */
function appendPackageExclusions(native: unknown, excludes: string[] | undefined): unknown[] | undefined {
	if (excludes === undefined || excludes.length === 0) {
		return Array.isArray(native) ? native : undefined;
	}
	const forceExcludes = excludes.map((rel) => `-${rel}`);
	if (native === undefined) return forceExcludes;
	if (!Array.isArray(native)) return undefined;
	if (native.length === 0) return native;
	return [...native, ...forceExcludes];
}

/** The package source string to emit. A user-scope relative local source
 *  resolves from the agent dir, which the instance moves, so emit the resolved
 *  root to keep the package's native identity and resolution meaning. Prefixed
 *  (npm/git/github), URL, absolute, and `~` sources already carry their root. */
function emittedPackageSource(source: string, discovery: DiscoveryContext): string {
	if (/^(npm|git|github):/.test(source)) return source;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) return source;
	if (path.isAbsolute(source) || source === "~" || source.startsWith("~/")) return source;
	return discovery.packages.find((pkg) => pkg.source === source)?.root ?? source;
}

/** Pi's built-in MCP discovery entry points (see installed Pi
 *  `dist/extensions/mcp/index.js`, `codemode/tool.js`, `tool-search/tool.js`).
 *  These are the tools a narrowed `tools` profile must keep reachable when an
 *  MCP server is enabled; their identities are Pi's, not a profile field. */
const MCP_GATEWAY_TOOL_NAMES = ["codemode", "tool_search"] as const;

/** Whether the prepared effective MCP set contains at least one enabled
 *  server (user-level snapshot entries with `enabled !== false`, plus any
 *  enabled trusted-project server Pi reads itself). */
function hasEnabledMcpServer(
	instanceMcpConfig: Record<string, unknown>,
	discovery: MergedMcpResult,
): boolean {
	const snapshotServers = instanceMcpConfig.mcpServers;
	if (isRecord(snapshotServers)) {
		for (const def of Object.values(snapshotServers)) {
			if (isRecord(def) && def.enabled !== false) return true;
		}
	}
	for (const name of discovery.projectServers) {
		const def = discovery.servers[name];
		if (def !== undefined && def.enabled !== false) return true;
	}
	return false;
}

function buildSelectionSettings(
	plan: ActivationPlan,
	userSettings: Record<string, unknown>,
	agentDir: string,
	discovery: DiscoveryContext,
	runtimeDir: string,
	projectDir?: string,
): Record<string, unknown> {
	const settings = { ...userSettings };
	const skillsDeclared = plan.resourceSelection.skills;
	const extensionsDeclared = plan.resourceSelection.extensions;

	const packageRoots = discovery.packages
		.filter((pkg): pkg is ConfiguredPackageRoot & { root: string } => pkg.root !== undefined)
		.map((pkg) => ({ ...pkg, root: pkg.root }));
	const projectExtensionsDir =
		projectDir !== undefined ? path.join(projectDir, ".pi", "extensions") : undefined;

	// --- skills ---
	// A declared kind is an allowlist over the user-level reference set. An
	// undeclared kind preserves native settings and the agentDir mirror.
	if (skillsDeclared) {
		const selectedPaths = new Set(plan.skills.map((skill) => skill.filePath));
		const skillEntries: string[] = [];
		for (const skill of plan.skills) {
			if (skill.origin === "package" || skill.scope === "project") continue;
			if (isUnderPath(skill.filePath, homeAgentsSkillsDir())) continue;
			skillEntries.push(skill.filePath);
		}
		for (const skill of discovery.skills) {
			if (skill.origin === "package" || skill.scope === "project" || selectedPaths.has(skill.filePath)) continue;
			skillEntries.push(...skillExclusionEntries(skill, agentDir, runtimeDir));
		}
		// Preserve the user's native controls, including exclusions absent from discovery.
		skillEntries.push(...userSkillExclusions(userSettings.skills, agentDir, runtimeDir));
		settings.skills = skillEntries;
	} else {
		const native = Array.isArray(settings.skills) ? settings.skills : [];
		const mappedNative = native.map((entry) =>
			typeof entry === "string" ? mapNativeSkillEntryNative(entry, agentDir, runtimeDir) : entry,
		);
		const exclusions = (plan.disabledSkills ?? [])
			.filter((skill) => skill.origin !== "package")
			.flatMap((skill) => skillExclusionEntries(skill, agentDir, runtimeDir));
		if (mappedNative.length > 0 || exclusions.length > 0) {
			settings.skills = [...mappedNative, ...exclusions];
		}
	}

	// --- extensions ---
	// Entries under a package root are encoded in that package's allowlist;
	// everything else becomes an additive absolute path.
	const packageExtensions = new Map<string, string[]>();
	const extensionEntries: string[] = [];
	if (extensionsDeclared) {
		for (const extension of plan.extensions) {
			// Loose project extensions are discovered natively by Pi; an explicit
			// path reference inside the project (outside `.pi/extensions`) is the
			// profile's own selection and stays.
			if (projectExtensionsDir !== undefined && isUnderPath(extension.entry, projectExtensionsDir)) continue;
			const owner = packageRoots.find((pkg) => isUnderPath(extension.entry, pkg.root));
			if (owner === undefined) {
				extensionEntries.push(extension.entry);
			} else {
				const list = packageExtensions.get(owner.source) ?? [];
				list.push(toPosix(path.relative(owner.root, extension.entry)));
				packageExtensions.set(owner.source, list);
			}
		}
		// Pi's built-in extension enable/disable controls are native settings,
		// not profile references: retain them so a declared extension selection
		// does not silently re-enable a built-in the user disabled.
		extensionEntries.push(...nativeBuiltinControls(userSettings.extensions));
		settings.extensions = extensionEntries;
	} else {
		const native = Array.isArray(settings.extensions) ? settings.extensions : [];
		// The instance mirrors the real extensions directory, so native entries
		// keep their native meaning: relative paths resolve through the mirror,
		// absolute controls map to it, escaping relatives are re-anchored, and
		// marker-less filters keep filtering the native plain entries only.
		const mappedNative = native.map((entry) =>
			typeof entry === "string" ? mapNativeExtensionEntry(entry, agentDir, runtimeDir) : entry,
		);
		const exclusions = (plan.disabledExtensions ?? [])
			.filter((extension) => extension.origin !== "package")
			.filter(
				(extension) =>
					projectExtensionsDir === undefined || !isUnderPath(extension.entry, projectExtensionsDir),
			)
			.map((extension) => extensionExclusionEntry(extension, agentDir, runtimeDir));
		const next = [...mappedNative, ...exclusions];
		if (next.length > 0) settings.extensions = next;
	}

	// --- packages ---
	const userPackages = Array.isArray(userSettings.packages) ? userSettings.packages : [];
	if (userPackages.length > 0) {
		const packageSkills = new Map<string, string[]>();
		if (skillsDeclared) {
			for (const skill of plan.skills) {
				if (skill.origin !== "package" || skill.baseDir === undefined) continue;
				const list = packageSkills.get(skill.source) ?? [];
				list.push(toPosix(path.relative(skill.baseDir, skill.filePath)));
				packageSkills.set(skill.source, list);
			}
		}
		// Overlay exclusions on an undeclared kind join this package's native
		// filter as package-relative force-exclusions.
		const disabledPackageSkills = new Map<string, string[]>();
		if (!skillsDeclared) {
			for (const skill of plan.disabledSkills ?? []) {
				if (skill.origin !== "package" || skill.baseDir === undefined) continue;
				const list = disabledPackageSkills.get(skill.source) ?? [];
				list.push(toPosix(path.relative(skill.baseDir, skill.filePath)));
				disabledPackageSkills.set(skill.source, list);
			}
		}
		const disabledPackageExtensions = new Map<string, string[]>();
		if (!extensionsDeclared) {
			for (const extension of plan.disabledExtensions ?? []) {
				if (extension.origin !== "package") continue;
				const owner = packageRoots.find((pkg) => isUnderPath(extension.entry, pkg.root));
				if (owner === undefined) continue;
				const list = disabledPackageExtensions.get(owner.source) ?? [];
				list.push(toPosix(path.relative(owner.root, extension.entry)));
				disabledPackageExtensions.set(owner.source, list);
			}
		}
		settings.packages = userPackages.map((pkg) => {
			const source = typeof pkg === "string" ? pkg : (pkg as { source: string }).source;
			const base: Record<string, unknown> =
				typeof pkg === "object" && pkg !== null ? { ...(pkg as Record<string, unknown>) } : { source };
			const rewritten: Record<string, unknown> = { ...base, source: emittedPackageSource(source, discovery) };
			// A declared kind replaces the package's filter with its allowlist; an
			// undeclared kind keeps the native filter (or its absence), with an
			// existing empty native filter staying empty. The two kinds are always
			// rewritten independently.
			if (skillsDeclared) {
				rewritten.skills = packageSkills.get(source) ?? [];
			} else {
				const next = appendPackageExclusions(base.skills, disabledPackageSkills.get(source));
				if (next === undefined) delete rewritten.skills;
				else rewritten.skills = next;
			}
			if (extensionsDeclared) {
				rewritten.extensions = packageExtensions.get(source) ?? [];
			} else {
				const next = appendPackageExclusions(base.extensions, disabledPackageExtensions.get(source));
				if (next === undefined) delete rewritten.extensions;
				else rewritten.extensions = next;
			}
			return rewritten;
		});
	}

	// --- unmanaged dirs pass through (prompts/themes) ---
	for (const kind of UNMANAGED_DIR_KINDS) {
		const resourceDir = path.join(agentDir, kind);
		if (existsSync(resourceDir)) {
			const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
			settings[kind] = [...entries, resourceDir];
		}
	}

	// --- profile defaults (Ticket 04) ---
	if (plan.model !== undefined) {
		settings.defaultProvider = plan.model.provider;
		settings.defaultModel = plan.model.id;
		if (plan.model.thinkingLevel !== undefined) {
			settings.defaultThinkingLevel = plan.model.thinkingLevel;
		}
	}
	if (plan.tools !== undefined) {
		settings.defaultTools = plan.tools;
	}

	// Project auto-discovery is suppressed entirely; selected project
	// resources enter additively through the trust-gated resolver.
	settings.defaultProjectTrust = "never";
	return settings;
}

export interface RuntimeFileOptions {
	/** The user's real agent dir (e.g. ~/.pi/agent). */
	agentDir: string;
	/** Optional home dir override (useful for testing). */
	homeDir?: string;
	/** Optional trusted project dir. */
	projectDir?: string;
	/** Required for selection plans; unused for the default profile. */
	discovery?: DiscoveryContext;
	/** Test seam; production callers use process.platform. */
	platform?: NodeJS.Platform;
	/** Extra launch-plan fields written by the in-session switch path:
	 *  `switchedFrom` triggers the one-shot change summary; `persistSelection`
	 *  tells the post-reload extension instance to save the selection;
	 *  `clearOverlay` drops the stored overlay
	 *  (a profile switch discards the previous profile's overlay).
	 *  `previousResolved` carries the pre-switch resolved name sets so
	 *  `/profile status` can report glob deltas (ticket 07). */
	planExtras?: {
		switchedFrom?: string;
		persistSelection?: boolean;
		clearOverlay?: boolean;
		previousResolved?: ResolvedNames;
	};
}

function applyDeclaredSubagents(
	settings: Record<string, unknown>,
	plan: ActivationPlan,
	settingsPath: string,
): Record<string, unknown> {
	try {
		return applySubagentSettings(settings, plan.subagents, { profile: plan.profile, settingsPath });
	} catch (error) {
		if (error instanceof SubagentSettingsError) throw new ActivationError(error.message);
		throw error;
	}
}

/** Computes the generated settings for a plan (pure-ish: reads the user's
 *  real settings + unmanaged dir existence, writes nothing). */
async function computeSettings(
	plan: ActivationPlan,
	options: RuntimeFileOptions,
	runtimeDir: string,
): Promise<Record<string, unknown>> {
	const { agentDir } = options;
	const userSettingsPath = path.join(agentDir, "settings.json");
	const userSettings: Record<string, unknown> = (await exists(userSettingsPath))
		? JSON.parse(await readFile(userSettingsPath, "utf8"))
		: {};

	if (plan.filter === "none") {
		// default profile: the user's global settings plus re-inclusion of the
		// real agent dir's resource dirs. User-defined keys, including their own
		// resource patterns and enable/disable state, are preserved untouched.
		// Project settings are NOT merged here: with native trust behavior, Pi
		// reads the project's settings itself.
		const settings = { ...userSettings };
		for (const kind of RESOURCE_DIR_KINDS) {
			const resourceDir = path.join(agentDir, kind);
			if (await exists(resourceDir)) {
				const entries = Array.isArray(settings[kind]) ? (settings[kind] as unknown[]) : [];
				settings[kind] = [...entries, resourceDir];
			}
		}
		return applyDeclaredSubagents(settings, plan, userSettingsPath);
	}

	// Selection plans: only user-scope encoding is layered onto the user's own
	// settings. The trusted project's `.pi/settings.json` is deliberately NOT
	// merged here — Pi reads it natively for the same trust decision this
	// process's Pi applies, and merging it would turn the project's `packages`
	// into global-scope packages (installing them into the real agent dir's npm
	// root as a launch side effect).
	const settings = buildSelectionSettings(
		plan,
		{ ...userSettings },
		agentDir,
		options.discovery ?? { skills: [], packages: [] },
		runtimeDir,
		options.projectDir,
	);
	return applyDeclaredSubagents(settings, plan, userSettingsPath);
}

/** Resolved name sets, carried in the launch plan for glob-delta reporting. */
export interface ResolvedNames {
	skills: string[];
	extensions: string[];
	tools?: string[];
	mcps?: string[];
}

/** How the instance's `extensions` path represents native discovery:
 *  - `mirror`: a selection plan omits extensions; the path is a symlink to the
 *    real agentDir extensions directory, dangling allowed.
 *  - `no-mirror`: a declared extension selection; no generated link, and
 *    unexpected real content at the path blocks activation.
 *  - `default`: the ordinary filter:none profile keeps its additive
 *    representation; only a known generated mirror is removed, foreign content
 *    is left untouched. */
type ExtensionPathRepresentation = "mirror" | "no-mirror" | "default";

function extensionPathRepresentation(plan: ActivationPlan): ExtensionPathRepresentation {
	if (plan.filter === "none") return "default";
	return plan.resourceSelection.extensions ? "no-mirror" : "mirror";
}

function instanceExtensionsPath(runtimeDir: string): string {
	return path.join(runtimeDir, "extensions");
}

/** `lstat` that only tolerates absence. A non-ENOENT failure must not be
 *  misclassified as "absent" — otherwise inaccessible non-symlink content could
 *  be treated as safe to replace. */
async function lstatOrNull(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
	try {
		return await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Validates the extension-path transition before any managed write. For a
 *  selection plan, unexpected real content at the managed path is refused with
 *  an actionable error; it is never deleted or overwritten. The ordinary
 *  default profile manages only its own generated mirror. */
async function assertExtensionPathTransition(
	runtimeDir: string,
	representation: ExtensionPathRepresentation,
): Promise<void> {
	if (representation === "default") return;
	const linkPath = instanceExtensionsPath(runtimeDir);
	const info = await lstatOrNull(linkPath);
	if (info === null || info.isSymbolicLink()) return;
	const remedy =
		representation === "mirror"
			? "so activation can link the real extensions directory"
			: "so the declared extension selection stays restrictive";
	throw new ActivationError(
		`the instance extension path "${linkPath}" contains a real ${info.isDirectory() ? "directory" : "file"} (not a symlink); pi-profile will not delete or overwrite it — move or remove it ${remedy}`,
	);
}

/** Applies the extension-path transition after the managed writes. Only the
 *  instance link is mutated; its target and real resources are never touched. */
async function applyExtensionPathTransition(
	runtimeDir: string,
	agentDir: string,
	representation: ExtensionPathRepresentation,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	const linkPath = instanceExtensionsPath(runtimeDir);
	const target = path.join(agentDir, "extensions");
	const info = await lstatOrNull(linkPath);
	if (representation === "default") {
		// Remove only a known generated mirror; foreign content is left alone.
		if (info?.isSymbolicLink()) {
			const current = await readlink(linkPath).catch(() => null);
			if (current !== null && path.resolve(current.replace(/^\\\\\?\\/, "")) === path.resolve(target)) await rm(linkPath, { force: true });
		}
		return;
	}
	if (representation === "mirror") {
		if (info?.isSymbolicLink()) {
			const current = await readlink(linkPath).catch(() => null);
			if (current !== null && path.resolve(current.replace(/^\\\\\?\\/, "")) === path.resolve(target)) return;
			await rm(linkPath, { force: true });
		} else if (info !== null) {
			// Already rejected by assertExtensionPathTransition; re-assert defensively.
			throw new ActivationError(
				`the instance extension path "${linkPath}" is not a symlink; pi-profile will not delete or overwrite it`,
			);
		}
		await symlink(target, linkPath, platform === "win32" ? "junction" : "dir");
		return;
	}
	// "no-mirror": remove a symlink at the managed path; leave real content alone.
	if (info?.isSymbolicLink()) await rm(linkPath, { force: true });
}

/** Writes settings.json + pi-profile.json into an existing runtime dir and
 *  keeps the trust.json link in place for every profile: Pi reads its
 *  project-scope decision from that path, and project-level resources belong
 *  to Pi's trust gate rather than to the profile.
 *
 *  All generated content (settings, launch plan, MCP snapshot, diagnostics)
 *  is prepared in memory before any runtime file is touched, so a discovery
 *  failure can never leave a half-written runtime dir (D3). */
export async function writeRuntimeFiles(
	runtimeDir: string,
	plan: ActivationPlan,
	options: RuntimeFileOptions,
): Promise<{ warnings: string[] }> {
	const warnings: string[] = [];
	const settings = await computeSettings(plan, options, runtimeDir);

	// Validate the extension-path transition before any managed write so an
	// unsafe pre-existing path fails actionably and leaves the runtime intact.
	const extensionsRepresentation = extensionPathRepresentation(plan);
	await assertExtensionPathTransition(runtimeDir, extensionsRepresentation);

	// Re-read sources in diagnostic mode and apply intent to the final snapshot.
	const discovery = await loadMergedMcpServers(options.agentDir, options.projectDir, {
		...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
		invalidSource: "diagnose",
	});
	const diagnostics = mergeResolutionDiagnostics(
		resolutionDiagnostics(plan).filter((issue) => issue.kind !== "mcp-source" && issue.kind !== "mcp-tools"),
		mcpSourceDiagnostics(plan.profile, discovery.diagnostics),
		mcpReferenceDiagnostics(plan.profile, discovery, plan.mcps, plan.mcpTools),
	);
	warnings.push(...diagnostics.map((issue) => issue.message));
	const instanceMcpConfig = buildInstanceMcpConfig(plan.profile, discovery, plan.mcps, plan.mcpTools);

	// When a profile narrows `tools` and the effective MCP set still has an
	// enabled server, keep Pi's native MCP discovery entry points reachable
	// (D4). The marker drives the session-start preservation; the
	// defaultTools baseline covers the boot window before session_start.
	const mcpGateways = plan.tools !== undefined && hasEnabledMcpServer(instanceMcpConfig, discovery);
	if (mcpGateways) {
		const current = Array.isArray(settings.defaultTools) ? (settings.defaultTools as string[]) : [];
		settings.defaultTools = [
			...current,
			...MCP_GATEWAY_TOOL_NAMES.filter((name) => !current.includes(name)),
		];
	}

	// The launch plan feeds the in-pi extension: tool re-application after
	// reload (the tools strict allowlist), in-session switching, status
	// reporting, and post-reload state persistence.
	// agentDir is the REAL agent dir — the extension needs it for trust
	// checks, state files, and catalog reads (its own
	// PI_CODING_AGENT_DIR points at this runtime dir).
	const launchPlan = {
		profile: plan.profile,
		source: plan.source,
		agentDir: options.agentDir,
		...(plan.subagents !== undefined ? { subagents: plan.subagents } : {}),
		...(plan.tools !== undefined ? { tools: plan.tools } : {}),
		...(plan.toolReferences !== undefined ? { toolReferences: plan.toolReferences } : {}),
		...(plan.disabledTools !== undefined ? { disabledTools: plan.disabledTools } : {}),
		...(plan.mcps !== undefined ? { mcps: plan.mcps } : {}),
		...(plan.mcpTools !== undefined ? { mcpTools: plan.mcpTools } : {}),
		...(mcpGateways ? { mcpGateways: true } : {}),
		// The resolved sets feed /profile status (absolute paths) and the
		// glob-delta diff against the previous activation.
		resolved: {
			skills: plan.skills.map((skill) => ({ name: skill.name, filePath: skill.filePath })),
			extensions: plan.extensions,
		},
		// Zero-match glob references (ADR-0009) — surfaced by /profile status
		// so a typo'd glob is visible instead of silently selecting nothing.
		...(plan.unmatched !== undefined ? { unmatched: plan.unmatched } : {}),
		...(diagnostics.length > 0 ? { diagnostics } : {}),
		...options.planExtras,
	};

	// --- write stage: all content is ready; no reads re-run here. ---
	await writeFile(path.join(runtimeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	await writeFile(path.join(runtimeDir, "pi-profile.json"), `${JSON.stringify(launchPlan, null, 2)}\n`);

	// Every profile gets the link, dangling allowed: Pi's stored trust decision
	// is what makes a trusted project's resources visible, and a decision Pi
	// writes through the link must land in the real agent dir (same shape as the
	// auth.json seed in ADR-0010). An entry that already exists is left alone —
	// a real file Pi wrote during this session carries its own decision.
	const trustLink = path.join(runtimeDir, "trust.json");
	await ensureSharedRuntimeFile(path.join(options.agentDir, "trust.json"), trustLink, {
		platform: options.platform,
		deferWhenMissing: true,
	});

	// MCP Servers generation: the instance mcp.json is always a generated
	// snapshot of the merged user-level configuration; it is never a symlink
	// or a copy of the real agentDir file (ADR-0016). The replacement content
	// was prepared above, so the old file is removed only once its successor
	// is ready to write.
	const mcpInstancePath = path.join(runtimeDir, "mcp.json");
	try { await rm(mcpInstancePath); } catch {}
	await writeFile(mcpInstancePath, JSON.stringify(instanceMcpConfig, null, 2));

	// Instructions generation (Ticket 04)
	const appendSystemPath = path.join(runtimeDir, "APPEND_SYSTEM.md");
	if (plan.instructions !== undefined && plan.instructions.trim() !== "") {
		await writeFile(appendSystemPath, plan.instructions);
	} else {
		try { await rm(appendSystemPath); } catch {}
	}

	// Platform-appropriate full-fidelity mirroring and stale mirror cleanup.
	await seedRuntimeStateDirs(options.agentDir);
	await syncAgentMirror(options.agentDir, runtimeDir, MANAGED_INSTANCE_FILES, { platform: options.platform });
	await seedRuntimeStateFiles(options.agentDir, runtimeDir, options.platform);
	// Omitted extension selection preserves native directory discovery.
	await applyExtensionPathTransition(runtimeDir, options.agentDir, extensionsRepresentation, options.platform);
	return { warnings };
}

/** Compatibility export retained for callers of the former POSIX-specific name. */
export async function syncAgentSymlinks(agentDir: string, runtimeDir: string): Promise<void> {
	await syncAgentMirror(agentDir, runtimeDir, MANAGED_INSTANCE_FILES);
}

async function seedRuntimeStateDirs(agentDir: string): Promise<void> {
	for (const name of SEEDED_STATE_DIRS) {
		try {
			await mkdir(path.join(agentDir, name), { recursive: true });
		} catch {
			// Best-effort: the mirror then simply links nothing for this name.
		}
	}
}

async function seedRuntimeStateFiles(
	agentDir: string,
	runtimeDir: string,
	platform?: NodeJS.Platform,
): Promise<void> {
	for (const name of SEEDED_STATE_FILES) {
		await ensureSharedRuntimeFile(path.join(agentDir, name), path.join(runtimeDir, name), {
			platform,
			deferWhenMissing: true,
		});
	}
}

export async function generateRuntimeDir(
	plan: ActivationPlan,
	options: GenerateOptions,
): Promise<GeneratedRuntime> {
	const { agentDir } = options;
	const runtimeRoot = getInstancesRootDir();
	await mkdir(runtimeRoot, { recursive: true });
	// One instance per launch, never reused: PI_CODING_AGENT_DIR is frozen for
	// the life of the spawned process, so a stable path cannot follow an
	// in-session switch, and a shared path would make concurrent launches (and
	// their switches) rewrite each other's files (ADR-0010).
	const runtimeDir = await mkdtemp(path.join(runtimeRoot, "launch-"));

	const { warnings } = await writeRuntimeFiles(runtimeDir, plan, options);

	return {
		runtimeDir,
		env: {
			PI_CODING_AGENT_DIR: runtimeDir,
		},
		agentDir,
		warnings,
	};
}
