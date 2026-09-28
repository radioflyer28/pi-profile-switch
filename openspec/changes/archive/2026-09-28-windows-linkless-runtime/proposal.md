# Proposal

## Why

The generated instance currently depends on symbolic links, which makes ordinary Windows launches require either Developer Mode or an elevated shell. Windows users should be able to launch profiles without weakening that machine-wide setting while preserving shared mutable state and safe stale-instance reclamation.

## What Changes

- Select a Windows instance-mirroring backend automatically: directory junctions for directories, hard links for existing files, and ordinary files for profile-generated configuration.
- Record Windows mirror ownership in a private per-instance manifest so hard links are distinguishable from runtime-created files during cleanup.
- Reconcile seeded mutable files that did not exist at launch after the child exits and during the next startup sweep, without pre-creating Pi-owned formats or silently overwriting concurrent state.
- Fail launch with an actionable error when an existing file cannot be hard-linked, including an unsupported cross-volume layout.
- Preserve the existing symbolic-link backend and behavior on non-Windows platforms.
- Add Windows-specific tests and CI coverage; no user-visible configuration field is introduced because platform discovery is sufficient.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `launcher`: Make the instance directory contract platform-aware while retaining shared state, no-copy profile resources, per-launch isolation, and safe reclamation.

## Impact

Affected code includes `src/settings-generator.ts`, a new Windows mirror module, stale-instance cleanup, subprocess finalization, in-session rollback, launcher tests, and CI. No runtime dependency is added. The private instance manifest is a new generated storage format and the Windows backend is a hard-to-reverse platform decision.

## Doc Impact

- `docs/prd.md`: none: product goals and non-goals are unchanged; profiles still reference resources rather than copying them.
- `docs/architecture/overview.md`: update the materialization, runtime-directory, seed, sweep, and known-limitation descriptions to distinguish POSIX and Windows mechanisms.
- `CONTEXT.md`: none: no terminology is added or changed.
- `docs/adr/`: add a new ADR for the Windows junction/hard-link backend, ownership manifest, and deferred reconciliation; link ADR-0010 where its symbolic-link-only decision is narrowed.
- `README.md` and `README.zh-CN.md`: document that Windows needs neither Developer Mode nor elevation and that the workspace must share a compatible local volume with the real agentDir.
