/**
 * SkillRegistry: mirrors Pi's native skill discovery result as a
 * name → final SKILL.md mapping.
 *
 * Implemented on top of the Pi SDK's DefaultResourceLoader pointed at the
 * real agent dir and cwd, so discovery rules and same-name priority stay
 * Pi's own — this module never re-implements directory scanning.
 *
 * Extensions are NOT loaded during discovery (`noExtensions`): extension code
 * must never execute as a side effect of resolving a profile. Skills that
 * extensions contribute at runtime are therefore absent here — they load with
 * their extension instead of being referenced by profiles.
 *
 * Discovery re-runs on every call, so newly added/removed skills are
 * reflected immediately (glob references re-expand at every start).
 */

import path from "node:path";

import { DefaultPackageManager, loadSkills, SettingsManager, type ResolvedResource } from "@earendil-works/pi-coding-agent";

export interface SkillEntry {
	/** Pi skill name (the profile-facing identity). */
	name: string;
	/** Absolute path of the winning SKILL.md (or lone .md) file. */
	filePath: string;
	/** Discovery source, e.g. "auto", "local", or a package source string. */
	source: string;
	/** "user" | "project" | "temporary" (Pi's SourceScope). */
	scope: string;
	/** "package" when contributed by an installed package, else "top-level". */
	origin: string;
	/** Package install root for package-origin skills (patterns are relative to it). */
	baseDir?: string;
}

export interface DiscoverSkillsOptions {
	cwd: string;
	agentDir: string;
	/**
	 * Whether the project at `cwd` is trusted (the launcher's trust check).
	 * Untrusted projects are never scanned: no project skills, no project
	 * settings packages. Defaults to false.
	 */
	projectTrusted?: boolean;
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillEntry[]> {
	// Project trust comes from the caller's trust check: discovery is the only
	// place project resources enter a plan's reference vocabulary (their
	// visibility in the session is Pi's, not the plan's).
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: options.projectTrusted ?? false,
	});
	const packageManager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager });
	// Supplying "skip" is Pi's explicit no-install path. Unlike PI_OFFLINE, this
	// is call-local: concurrent parent/child resolution never mutates process
	// environment or changes another loader's behavior.
	const resolved = await packageManager.resolve(async () => "skip");
	const resources = resolved.skills.filter((resource) => resource.enabled);
	const skills = loadSkills({
		cwd: options.cwd,
		agentDir: options.agentDir,
		skillPaths: resources.map((resource) => resource.path),
		includeDefaults: false,
	}).skills;
	const metadataFor = (filePath: string): ResolvedResource["metadata"] | undefined => {
		const absolute = path.resolve(filePath);
		return resources
			.filter((resource) => {
				const candidate = path.resolve(resource.path);
				return absolute === candidate || absolute.startsWith(`${candidate}${path.sep}`) || absolute === path.join(candidate, "SKILL.md");
			})
			.sort((a, b) => b.path.length - a.path.length)[0]?.metadata;
	};
	return skills.flatMap((skill) => {
		const sourceInfo = metadataFor(skill.filePath) ?? skill.sourceInfo;

		// Project-scoped package skills stay out of the reference vocabulary:
		// their packages live under the project's .pi/npm and Pi discovers their
		// skills natively, so a profile reference would add nothing. Project
		// .pi/skills and ancestor .agents/skills are referenceable.
		if (sourceInfo.origin === "package" && sourceInfo.scope === "project") return [];
		return [{
			name: skill.name,
			filePath: skill.filePath,
			source: sourceInfo.source,
			scope: sourceInfo.scope,
			origin: sourceInfo.origin,
			baseDir: sourceInfo.baseDir,
		}];
	});
}
