# Design

## Context

See [proposal.md](proposal.md#why). The instance currently consists of generated files plus symbolic links into the real agentDir. Windows only permits ordinary users to create symbolic links when Developer Mode is enabled, but directory junctions and file hard links do not require that privilege. Hard links require an existing file on the same volume, while the current dangling links deliberately support state files whose Pi-owned format does not yet exist. Stale cleanup currently recognizes generated mirrors by file type alone, which is insufficient because hard links look like ordinary files.

ADR-0010 also requires per-launch paths, startup recovery after abrupt termination, and no pre-created guesses for Pi-owned file formats. ADR-0012 permits generic adoption but uses a real-wins conflict rule that is too destructive for known mutable credential and trust files created concurrently.

## Goals / Non-Goals

**Goals:**

- Use no privilege-requiring symbolic links when `process.platform === "win32"`.
- Keep existing mutable files live-shared and preserve missing mutable files without guessing their format.
- Make both normal child exit and later startup sweep converge after interruption.
- Fail closed on ownership ambiguity, divergent concurrent state, and unsupported file sharing.
- Leave the non-Windows backend byte-for-byte compatible in behavior.

**Non-Goals:**

- Providing an OS sandbox or protection from a child running with the user's own filesystem permissions.
- Merging divergent JSON or understanding credential, model-store, or trust formats.
- Supporting hard links across filesystems by silently copying existing configuration.
- Changing profile definitions or adding user configuration.

## Decisions

### D1. Platform-selected mirror backend

`src/runtime-mirror.ts` will own mirror mechanics. Non-Windows continues to create symbolic links. Windows creates directory junctions for directory referents and hard links for existing file referents. A source symbolic link is resolved before the Windows entry is created, so the instance itself contains no symbolic link.

Junctions are selected over recursive directory copies because they preserve live state and resource updates. Hard links are selected over file copies because OAuth refreshes, trust changes, and package metadata writes must remain visible through both paths. Existing file hard-link failure is fatal and wrapped in an actionable `RuntimeMaterializationError`; omission or a copy fallback would silently change Pi behavior.

The Node `symlink(..., "junction")` API is used only to request an NTFS junction on Windows; it does not request the symbolic-link privilege whose absence motivates this change.

### D2. Private ownership manifest

ADR required: windows-linkless-instance-mirror

Every Windows instance contains the managed `pi-profile-mirror.json` manifest:

```ts
interface WindowsMirrorManifestV1 {
  version: 1;
  backend: "windows-junction-hardlink";
  entries: Record<string, "junction" | "hardlink" | "deferred-file">;
}
```

Keys are single top-level basenames. Targets are not stored; they are derived as `<realAgentDir>/<name>` to avoid turning child-controlled manifest data into arbitrary write destinations. Manifest parsing rejects unknown keys, path separators, unknown entry kinds, and unknown versions. A manifest declaration is never sufficient by itself: hard links are validated by filesystem identity and junctions by resolved destination. Invalid or unverifiable entries fall back to existing unrecognized-entry handling.

A missing or partially written manifest is safe: hard links appear unrecognized and the existing cleanup path either removes the redundant instance name when the real name exists or keeps data it cannot classify. Manifest writes are intentionally replaceable private state; corruption cannot authorize a deletion.

### D3. Deferred missing mutable files

A missing seeded mutable file, including the always-managed trust file, is represented by a `deferred-file` manifest entry and no placeholder. Pi can then decide whether and what to write inside the instance. After child exit, and again during stale startup cleanup, reconciliation handles a resulting regular file:

1. If the real target is absent, rename it into place. On cross-device rename, use exclusive-create copying and remove the instance file only after copy success.
2. If the target exists with identical bytes, remove the redundant instance file.
3. If the target exists with different bytes, keep both and emit an actionable warning. Never apply ADR-0012's generic real-wins deletion to this known mutable state.

The operation is idempotent. The normal exit hook improves immediacy; startup cleanup remains authoritative recovery for launcher crashes and forced termination. File-content merging is rejected because it would couple pi-profile to private formats. Empty placeholders are rejected by ADR-0010.

### D4. In-session switching preserves shared-file identity

Rollback snapshots gain a hard-link form for managed files that share identity with the corresponding real-agentDir file. Restore recreates that hard link instead of writing a private copy. For unchanged regular-file snapshots, restoration first compares current content and mode and does nothing when equal, preserving hard-link identity. This is required for unrestricted `mcp.json` and `trust.json` across a failed switch.

### D5. Export surface and sequencing

`src/runtime-mirror.ts` exports:

```ts
export class RuntimeMaterializationError extends Error

export interface MirrorOptions {
  platform?: NodeJS.Platform;
}

export interface MirrorReconciliationResult {
  notices: string[];
  warnings: string[];
  keptNames: string[];
}

export async function syncAgentMirror(
  agentDir: string,
  runtimeDir: string,
  managedNames: ReadonlySet<string>,
  options?: MirrorOptions,
): Promise<void>;

export async function ensureSharedRuntimeFile(
  agentFile: string,
  runtimeFile: string,
  options: MirrorOptions & { deferWhenMissing: boolean },
): Promise<void>;

export async function inspectOwnedMirrorNames(
  runtimeDir: string,
  agentDir: string,
): Promise<Set<string>>;

export async function reconcileDeferredRuntimeFiles(
  runtimeDir: string,
  agentDir: string,
): Promise<MirrorReconciliationResult>;
```

`RuntimeFileOptions`, `GenerateOptions`, and `SwitchDeps` gain optional `platform?: NodeJS.Platform` only as a deterministic test seam; production callers omit it. `GeneratedRuntime` gains `agentDir` so `spawnPi` can run reconciliation after child exit without trusting manifest paths.

Materialization order is generated settings and plan, platform-appropriate trust/MCP handling, instructions, state seeding, general mirroring, then manifest completion. Cleanup order is liveness, deferred reconciliation, validated ownership inspection, existing unrecognized classification, and deletion. Reconciliation warnings are printed by both launcher finalization and the next startup sweep.

The existing `syncAgentSymlinks()` export remains as a compatibility alias for the non-Windows-default `syncAgentMirror()` entry point; new internal calls use the backend-neutral name.

## Risks / Trade-offs

- **[Concurrent first-time credential writes can diverge]** → Never overwrite either version; retain the stale instance and print the exact conflict for manual resolution.
- **[Hard links are unavailable across volumes or on some filesystems]** → Abort before spawn with source and remediation instead of silently omitting or copying a live file.
- **[A launcher is killed before exit reconciliation]** → The next startup sweep repeats reconciliation from the manifest.
- **[A corrupt manifest misclassifies state]** → Validate syntax, constrain names, derive targets, and verify filesystem identity; ambiguity falls back to keep/adopt rules.
- **[Junction behavior cannot be faithfully proven on Linux]** → Add a Windows CI job for focused materialization, switching, reconciliation, and cleanup tests while retaining Linux full-suite coverage.
- **[Hard-linked writes through replace-by-rename break sharing]** → Later in-session rewrites re-run mirror synchronization; deferred recovery protects only the explicitly seeded missing files. Pi-owned replacement behavior remains covered by subprocess tests.

## Migration Plan

Existing non-Windows instances remain compatible and use no manifest. Existing Windows symlink-based stale instances remain reclaimable through the old symbolic-link recognition path. New Windows instances use the manifest automatically; there is no user migration or configuration change.

Rollback consists of reverting the feature commit. Stale manifested instances then fail safe as ordinary unrecognized entries or redundant real-name conflicts; users can allow one launch of the feature branch to reconcile deferred files before rollback if needed.
