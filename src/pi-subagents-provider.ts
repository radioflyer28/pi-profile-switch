import { resolveNamedChildProfile, type ResolveNamedChildProfileOptions, type ResolvedChildProfileV1 } from "./child-profile-resolver.ts";

export interface PiSubagentsChildProfileProviderOptions {
	agentDir: string;
	profilesDir?: string;
	projectTrusted?: boolean;
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
		resolve: ({ name, cwd }) => resolveNamedChildProfile({
			name,
			cwd,
			agentDir: options.agentDir,
			...(options.profilesDir ? { profilesDir: options.profilesDir } : {}),
			...(options.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}),
			...(options.allowProjectProfiles !== undefined ? { allowProjectProfiles: options.allowProjectProfiles } : {}),
			...(options.validateModel ? { validateModel: options.validateModel } : {}),
			...(options.piVersion ? { piVersion: options.piVersion } : {}),
		}),
	};
}
