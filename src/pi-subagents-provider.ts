import { resolveNamedChildProfile, type ResolveNamedChildProfileOptions, type ResolvedChildProfileV1 } from "./child-profile-resolver.ts";

export interface PiSubagentsChildProfileProviderOptions {
	agentDir: string;
	profilesDir?: string;
	/** Host-owned trust decision evaluated independently for every target cwd. */
	resolveProjectTrust?: (cwd: string) => boolean | Promise<boolean>;
	allowProjectProfiles?: boolean;
	validateModel?: ResolveNamedChildProfileOptions["validateModel"];
	piVersion?: string;
}

/**
 * Structural provider adapter for `registerChildProfileProvider` from
 * `pi-subagents/child-profiles`. Keeping registration in the host avoids a
 * hard runtime dependency in either direction.
 */
export function createPiSubagentsChildProfileProvider(options: PiSubagentsChildProfileProviderOptions): {
	name: "pi-profile-switch";
	resolve(request: { name: string; cwd: string; backend: "process" | "session" }): Promise<ResolvedChildProfileV1>;
} {
	return {
		name: "pi-profile-switch",
		resolve: async ({ name, cwd }) => resolveNamedChildProfile({
			name,
			cwd,
			agentDir: options.agentDir,
			...(options.profilesDir ? { profilesDir: options.profilesDir } : {}),
			projectTrusted: options.resolveProjectTrust ? await options.resolveProjectTrust(cwd) : false,
			...(options.allowProjectProfiles !== undefined ? { allowProjectProfiles: options.allowProjectProfiles } : {}),
			...(options.validateModel ? { validateModel: options.validateModel } : {}),
			...(options.piVersion ? { piVersion: options.piVersion } : {}),
		}),
	};
}
