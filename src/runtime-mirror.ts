import { constants } from "node:fs";
import {
	copyFile,
	link,
	lstat,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

export const WINDOWS_MIRROR_MANIFEST = "pi-profile-mirror.json";

const WINDOWS_BACKEND = "windows-junction-hardlink" as const;
const WINDOWS_ENTRY_KINDS = new Set(["junction", "hardlink", "deferred-file"] as const);

type WindowsMirrorEntryKind = "junction" | "hardlink" | "deferred-file";

interface WindowsMirrorManifestV1 {
	version: 1;
	backend: typeof WINDOWS_BACKEND;
	entries: Record<string, WindowsMirrorEntryKind>;
}

export class RuntimeMaterializationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RuntimeMaterializationError";
	}
}

export interface MirrorOptions {
	/** Test seam; production callers use process.platform. */
	platform?: NodeJS.Platform;
}

export interface MirrorReconciliationResult {
	notices: string[];
	warnings: string[];
	keptNames: string[];
}

function selectedPlatform(options?: MirrorOptions): NodeJS.Platform {
	return options?.platform ?? process.platform;
}

async function lexicalStat(filePath: string) {
	try {
		return await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function isSafeManifestName(name: string): boolean {
	return (
		name.length > 0 &&
		name !== "." &&
		name !== ".." &&
		path.basename(name) === name &&
		!name.includes("/") &&
		!name.includes("\\")
	);
}

function emptyManifest(): WindowsMirrorManifestV1 {
	return { version: 1, backend: WINDOWS_BACKEND, entries: {} };
}

async function readWindowsManifest(runtimeDir: string): Promise<WindowsMirrorManifestV1 | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path.join(runtimeDir, WINDOWS_MIRROR_MANIFEST), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		Object.keys(candidate).sort().join(",") !== "backend,entries,version" ||
		candidate.version !== 1 ||
		candidate.backend !== WINDOWS_BACKEND
	) return undefined;
	if (typeof candidate.entries !== "object" || candidate.entries === null || Array.isArray(candidate.entries)) {
		return undefined;
	}
	const entries: Record<string, WindowsMirrorEntryKind> = {};
	for (const [name, kind] of Object.entries(candidate.entries as Record<string, unknown>)) {
		if (!isSafeManifestName(name) || !WINDOWS_ENTRY_KINDS.has(kind as WindowsMirrorEntryKind)) return undefined;
		entries[name] = kind as WindowsMirrorEntryKind;
	}
	return { version: 1, backend: WINDOWS_BACKEND, entries };
}

async function updateWindowsManifest(
	runtimeDir: string,
	mutate: (manifest: WindowsMirrorManifestV1) => void,
): Promise<void> {
	const manifest = (await readWindowsManifest(runtimeDir)) ?? emptyManifest();
	mutate(manifest);
	await writeFile(path.join(runtimeDir, WINDOWS_MIRROR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function sameFileIdentity(first: string, second: string): Promise<boolean> {
	try {
		const [a, b] = await Promise.all([stat(first), stat(second)]);
		return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
	} catch {
		return false;
	}
}

async function sameResolvedDirectory(first: string, second: string): Promise<boolean> {
	try {
		const [a, b, firstInfo, secondInfo] = await Promise.all([
			realpath(first),
			realpath(second),
			stat(first),
			stat(second),
		]);
		return firstInfo.isDirectory() && secondInfo.isDirectory() && path.resolve(a) === path.resolve(b);
	} catch {
		return false;
	}
}

async function filesEqual(first: string, second: string): Promise<boolean> {
	try {
		const [aInfo, bInfo] = await Promise.all([stat(first), stat(second)]);
		if (!aInfo.isFile() || !bInfo.isFile() || aInfo.size !== bInfo.size) return false;
		if (aInfo.dev === bInfo.dev && aInfo.ino === bInfo.ino) return true;
		const [a, b] = await Promise.all([readFile(first), readFile(second)]);
		return a.equals(b);
	} catch {
		return false;
	}
}

function hardLinkError(agentFile: string, runtimeFile: string, error: unknown): RuntimeMaterializationError {
	const detail = error instanceof Error ? error.message : String(error);
	return new RuntimeMaterializationError(
		`cannot mirror ${agentFile} into the Windows profile instance (${runtimeFile}) without copying it: ${detail}. ` +
			`Set PI_PROFILE_SWITCH_DIR to a location on the same local volume as the real agent directory, or move the agent directory and profile workspace onto compatible NTFS storage.`,
		{ cause: error },
	);
}

async function createWindowsMirror(agentPath: string, runtimePath: string): Promise<WindowsMirrorEntryKind> {
	const info = await stat(agentPath);
	const source = await realpath(agentPath);
	if (info.isDirectory()) {
		await symlink(source, runtimePath, "junction");
		return "junction";
	}
	if (info.isFile()) {
		try {
			await link(source, runtimePath);
		} catch (error) {
			throw hardLinkError(agentPath, runtimePath, error);
		}
		return "hardlink";
	}
	throw new RuntimeMaterializationError(
		`cannot mirror ${agentPath} into the Windows profile instance: only regular files and directories are supported`,
	);
}

/** Ensures one managed runtime file shares the real file, or records a missing
 * mutable file for post-process reconciliation on Windows. */
export async function ensureSharedRuntimeFile(
	agentFile: string,
	runtimeFile: string,
	options: MirrorOptions & { deferWhenMissing: boolean },
): Promise<void> {
	const platform = selectedPlatform(options);
	const targetLexical = await lexicalStat(agentFile);
	const current = await lexicalStat(runtimeFile);

	if (platform !== "win32") {
		if (targetLexical === undefined) {
			if (current === undefined && options.deferWhenMissing) await symlink(agentFile, runtimeFile);
			return;
		}
		if (current?.isSymbolicLink() && (await readlink(runtimeFile).catch(() => undefined)) === agentFile) return;
		if (current !== undefined) await rm(runtimeFile, { recursive: true, force: true });
		await symlink(agentFile, runtimeFile);
		return;
	}

	const name = path.basename(runtimeFile);
	if (!isSafeManifestName(name)) {
		throw new RuntimeMaterializationError(`cannot record unsafe Windows mirror entry name: ${name}`);
	}

	if (targetLexical === undefined) {
		if (!options.deferWhenMissing) return;
		await updateWindowsManifest(path.dirname(runtimeFile), (manifest) => {
			manifest.entries[name] = "deferred-file";
		});
		return;
	}
	let target;
	try {
		target = await stat(agentFile);
	} catch (error) {
		throw new RuntimeMaterializationError(
			`cannot mirror ${agentFile} into the Windows profile instance: its referent is missing or unreadable`,
			{ cause: error },
		);
	}
	if (!target.isFile()) {
		throw new RuntimeMaterializationError(`cannot mirror ${agentFile}: expected a regular file`);
	}
	if (current !== undefined) {
		if (await sameFileIdentity(agentFile, runtimeFile)) {
			await updateWindowsManifest(path.dirname(runtimeFile), (manifest) => {
				manifest.entries[name] = "hardlink";
			});
			return;
		}
		// A deferred file created by Pi is state, not a generated entry. Leave it
		// for reconciliation rather than replacing or writing through it.
		const manifest = await readWindowsManifest(path.dirname(runtimeFile));
		if (manifest?.entries[name] === "deferred-file") return;
		await rm(runtimeFile, { recursive: true, force: true });
	}
	try {
		await link(await realpath(agentFile), runtimeFile);
	} catch (error) {
		throw hardLinkError(agentFile, runtimeFile, error);
	}
	await updateWindowsManifest(path.dirname(runtimeFile), (manifest) => {
		manifest.entries[name] = "hardlink";
	});
}

/** Mirrors every non-managed top-level entry of agentDir into runtimeDir. */
export async function syncAgentMirror(
	agentDir: string,
	runtimeDir: string,
	managedNames: ReadonlySet<string>,
	options?: MirrorOptions,
): Promise<void> {
	if (path.resolve(agentDir) === path.resolve(runtimeDir)) return;
	let sourceNames: string[];
	try {
		sourceNames = await readdir(agentDir);
	} catch {
		return;
	}
	const platform = selectedPlatform(options);
	if (platform !== "win32") {
		let runtimeNames: string[] = [];
		try {
			runtimeNames = await readdir(runtimeDir);
		} catch {}
		for (const name of runtimeNames) {
			if (managedNames.has(name)) continue;
			const runtimePath = path.join(runtimeDir, name);
			try {
				if ((await lstat(runtimePath)).isSymbolicLink() && !(await lexicalStat(path.join(agentDir, name)))) {
					await rm(runtimePath, { recursive: true, force: true });
				}
			} catch {}
		}
		for (const name of sourceNames) {
			if (managedNames.has(name)) continue;
			const agentPath = path.join(agentDir, name);
			const runtimePath = path.join(runtimeDir, name);
			try {
				const current = await lexicalStat(runtimePath);
				if (current?.isSymbolicLink() && (await readlink(runtimePath).catch(() => undefined)) === agentPath) continue;
				if (current !== undefined) await rm(runtimePath, { recursive: true, force: true });
				const info = await stat(agentPath);
				await symlink(agentPath, runtimePath, info.isDirectory() ? "dir" : "file");
			} catch {
				// Preserve the historical best-effort POSIX mirror behavior.
			}
		}
		return;
	}

	const manifest = (await readWindowsManifest(runtimeDir)) ?? emptyManifest();
	const sourceSet = new Set(sourceNames);
	for (const [name, kind] of Object.entries(manifest.entries)) {
		if (managedNames.has(name) || kind === "deferred-file" || sourceSet.has(name)) continue;
		await rm(path.join(runtimeDir, name), { recursive: true, force: true }).catch(() => undefined);
		delete manifest.entries[name];
	}

	for (const name of sourceNames) {
		if (managedNames.has(name)) continue;
		const agentPath = path.join(agentDir, name);
		const runtimePath = path.join(runtimeDir, name);
		const currentKind = manifest.entries[name];
		if (
			(currentKind === "hardlink" && (await sameFileIdentity(agentPath, runtimePath))) ||
			(currentKind === "junction" && (await sameResolvedDirectory(agentPath, runtimePath)))
		) {
			continue;
		}
		if ((await lexicalStat(runtimePath)) !== undefined) {
			if (currentKind === "hardlink" || currentKind === "junction") {
				await rm(runtimePath, { recursive: true, force: true });
			} else {
				// Never replace state not attributed to this backend.
				continue;
			}
		}
		manifest.entries[name] = await createWindowsMirror(agentPath, runtimePath);
	}
	await writeFile(path.join(runtimeDir, WINDOWS_MIRROR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Returns only manifest entries whose actual filesystem identity validates. */
export async function inspectOwnedMirrorNames(runtimeDir: string, agentDir: string): Promise<Set<string>> {
	const owned = new Set<string>();
	const manifest = await readWindowsManifest(runtimeDir);
	if (manifest === undefined) return owned;
	for (const [name, kind] of Object.entries(manifest.entries)) {
		if (kind === "deferred-file") continue;
		const runtimePath = path.join(runtimeDir, name);
		const agentPath = path.join(agentDir, name);
		if (kind === "hardlink" && (await sameFileIdentity(runtimePath, agentPath))) owned.add(name);
		if (kind === "junction" && (await sameResolvedDirectory(runtimePath, agentPath))) owned.add(name);
	}
	return owned;
}

async function preserveDeferredFile(runtimePath: string, agentPath: string): Promise<"moved" | "same" | "conflict"> {
	if ((await lexicalStat(agentPath)) !== undefined) {
		if (await filesEqual(runtimePath, agentPath)) {
			await rm(runtimePath, { force: true });
			return "same";
		}
		return "conflict";
	}
	try {
		await rename(runtimePath, agentPath);
		return "moved";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EXDEV") {
			if ((await lexicalStat(agentPath)) !== undefined) return preserveDeferredFile(runtimePath, agentPath);
			throw error;
		}
	}
	try {
		await copyFile(runtimePath, agentPath, constants.COPYFILE_EXCL);
		await rm(runtimePath, { force: true });
		return "moved";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return preserveDeferredFile(runtimePath, agentPath);
		throw error;
	}
}

/** Reconciles Pi-owned state files that could not be hard-linked because they
 * did not exist when a Windows instance was materialized. Safe to repeat. */
export async function reconcileDeferredRuntimeFiles(
	runtimeDir: string,
	agentDir: string,
): Promise<MirrorReconciliationResult> {
	const result: MirrorReconciliationResult = { notices: [], warnings: [], keptNames: [] };
	const manifest = await readWindowsManifest(runtimeDir);
	if (manifest === undefined) return result;
	for (const [name, kind] of Object.entries(manifest.entries)) {
		if (kind !== "deferred-file") continue;
		const runtimePath = path.join(runtimeDir, name);
		const info = await lexicalStat(runtimePath).catch(() => undefined);
		if (info === undefined) continue;
		if (!info.isFile() || info.isSymbolicLink()) {
			result.keptNames.push(name);
			result.warnings.push(`${runtimePath} was not reconciled: expected a regular file created by Pi`);
			continue;
		}
		try {
			const disposition = await preserveDeferredFile(runtimePath, path.join(agentDir, name));
			if (disposition === "conflict") {
				result.keptNames.push(name);
				result.warnings.push(
					`${runtimePath} differs from ${path.join(agentDir, name)}; both files were kept. ` +
						`Resolve the concurrent state conflict manually, then delete the stale instance.`,
				);
			} else if (disposition === "moved") {
				result.notices.push(`preserved ${name} from ${runtimeDir} in the real agent dir (${agentDir})`);
			}
		} catch (error) {
			result.keptNames.push(name);
			result.warnings.push(
				`${runtimePath} could not be reconciled with ${path.join(agentDir, name)}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return result;
}
