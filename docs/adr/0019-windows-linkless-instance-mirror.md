# Windows instances use junctions, hard links, and deferred state reconciliation

Supersedes ADR-0010 only for the instance-mirror mechanism on Windows. ADR-0010's per-launch directory, liveness, seeding evidence, and startup-sweep decisions remain in force.

## Context

ADR-0010 anchored real-agentDir state through symbolic links, including dangling links for files whose format belongs to Pi. On Windows, creating those links as an ordinary user requires Developer Mode or an elevated process. Requiring either for every profile launch is unnecessary because Windows offers unprivileged directory junctions and same-volume file hard links.

Neither primitive replaces a dangling file link. A hard link requires an existing file and cannot cross volumes. Copying all state at launch would split live OAuth refreshes, trust decisions, sessions, package roots, and extension state. Pre-creating empty credential or model files would revive the Pi-format coupling rejected by ADR-0010. Hard links also appear as ordinary files, so ADR-0010's file-type-based stale cleanup cannot attribute them safely.

## Decision

The instance mirror is platform selected and automatic.

- Non-Windows launches retain symbolic-link mirroring.
- Windows directories use junctions whose referents are resolved before creation.
- Windows files that exist at materialization time use hard links. A hard-link failure aborts launch with a same-volume remediation; existing files are never copied as a fallback.
- Windows files that are explicitly seeded but absent at materialization time remain absent. A private per-instance ownership manifest records them as deferred.
- Deferred files created by Pi are reconciled after child exit. A later startup sweep repeats reconciliation after interruption: an absent real target receives the file, identical duplicates collapse, and divergent files are both kept with a warning.
- The ownership manifest stores only top-level names and entry kinds. Real targets are derived from the trusted real agentDir. Cleanup validates hard-link identity and junction destination before treating an entry as generated; malformed or unverifiable records grant no ownership.

The manifest is private generated state, versioned independently of user configuration. It is managed and reclaimable with its instance.

## Rejected alternatives

**Require Developer Mode.** It solves creation but changes a machine-wide security posture for a package implementation detail and is often unavailable on managed machines.

**Run the launcher elevated.** Repeated elevation worsens usability and would run Pi with broader rights than the user's normal development shell.

**Copy the agent directory.** Mutable state would diverge while Pi runs, and resource implementations would become snapshots, violating the no-copy profile model.

**Copy only mutable files back at exit.** It still splits live state, cannot cover abrupt launcher termination without a recovery ledger, and creates silent last-writer-wins data loss under concurrency. Hard links avoid the split whenever a source exists; deferred reconciliation explicitly retains divergent first-write races.

**Pre-create known empty JSON files.** Their formats belong to Pi and may change. Absence can itself carry semantics.

**Use only junctions by reorganizing the real agentDir.** Managed generated files and pass-through state share the same directory, so the launcher cannot junction the whole root while replacing selected entries.

## Consequences

- Ordinary Windows users can launch profiles without Developer Mode or elevation.
- `PI_PROFILE_SWITCH_DIR` must be on storage compatible with hard links to real-agentDir files; the default under the same home directory normally satisfies this.
- First creation of a deferred file is private until normal exit reconciliation. A killed launcher leaves it recoverable by the next sweep.
- Concurrent first creation can produce divergent files. The launcher does not understand or merge those formats; it keeps both and requires manual resolution.
- Windows cleanup depends on a validated manifest rather than on file type alone. Manifest loss degrades to the conservative unrecognized-entry rules.
- Source symbolic links are resolved into a junction or hard link in the Windows instance; the instance does not reproduce the privilege-requiring symbolic link.
