# launcher Spec Delta

## MODIFIED Requirements

### Requirement: Instance directory contract

The launcher SHALL generate one instance directory per launch at `<PI_PROFILE_SWITCH_DIR>/instances/launch-<random id>`, with the workspace root defaulting to `~/.pi-profile-switch`. Each launch SHALL use a previously nonexistent path; multiple launches of the same profile MUST NOT reuse the same path.

The directory SHALL be handed to the Pi process via `PI_CODING_AGENT_DIR`. The launcher SHALL remove `PI_CODING_AGENT_SESSION_DIR` from the child process environment so that session storage is decided by the instance; the instance's `sessions` is a mirror of the real agentDir's corresponding directory.

The managed files in the instance SHALL defer to the authoritative managed-file set in `src/settings-generator.ts`; `pid` SHALL record the Pi child process ID of this launch. On non-Windows platforms, all other files and directories under the real agentDir SHALL be mirrored into the instance as symbolic links, with broken links cleaned up at link time. On Windows, the launcher SHALL NOT create symbolic links that require Developer Mode or elevation: existing directories SHALL be mirrored through directory links supported for an unelevated account, and existing files SHALL share storage with the corresponding real-agentDir files. Windows mirror ownership SHALL be recorded in a private generated manifest so cleanup can distinguish generated entries from runtime-created state.

On Windows, launch SHALL fail before starting Pi when an existing real-agentDir file cannot be represented without copying, including when the instance and real file reside on volumes that cannot share file storage. The failure SHALL identify the source entry and explain how to select a compatible `PI_PROFILE_SWITCH_DIR` volume. User configuration files MUST NOT be copied as a fallback.

`trust.json` SHALL point at or share storage with the corresponding path in the real agentDir for every profile when that target exists. When it does not exist at Windows launch time, it SHALL follow the deferred mutable-file rules in "Instance runtime-state seed". It MUST NOT be omitted from preservation because the profile is not `default`.

When a profile declares `mcps`, the instance's `mcp.json` SHALL be the generated filter result containing only the allowed server definitions. For unselected servers in user-level shared locations (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`), the instance configuration SHALL explicitly mark them disabled and MUST NOT rely on omission alone: these locations are read directly by the adapter, and without a disable mark an omitted server does not become ineffective. Servers defined in project-level locations (project `.mcp.json`, project `.pi/mcp.json`) SHALL stay enabled and MUST NOT be marked disabled.

User configuration files MUST NOT be modified except by writes performed through a shared instance entry or the deferred mutable-file reconciliation contract.

#### Scenario: Instance path fixed per profile

- **WHEN** the same profile is launched twice in a row
- **THEN** the two launches use different instance paths (scenario name kept from the old contract's wording; the assertion has been inverted)

#### Scenario: Unrestricted MCP configuration is linked directly

- **WHEN** the profile does not declare `mcps` and `mcp.json` exists under the real agentDir
- **THEN** the instance's `mcp.json` shares that file's storage and its content is not rewritten

#### Scenario: Named profiles do link trust.json

- **WHEN** launched with a named profile and `trust.json` exists under the real agentDir
- **THEN** the instance's `trust.json` points at or shares storage with the corresponding real-agentDir file

#### Scenario: Windows launch requires no symbolic-link privilege

- **WHEN** the launcher runs on Windows in an unelevated account without Developer Mode
- **THEN** instance materialization succeeds without requesting symbolic-link privilege

#### Scenario: Windows existing file is on an incompatible volume

- **WHEN** a real-agentDir file cannot share storage with the Windows instance because their volumes are incompatible
- **THEN** startup fails before Pi is spawned, names the source entry, and explains that `PI_PROFILE_SWITCH_DIR` must use a compatible volume

#### Scenario: Restricted MCP configuration disables unselected shared servers

- **WHEN** the profile declares `mcps` allowing only server A, while the user-level shared configuration also defines server B
- **THEN** the instance's `mcp.json` contains A's definition and contains B with a disable mark; B is not connected

#### Scenario: Project-sourced MCP servers are not disabled

- **WHEN** the profile declares `mcps` allowing only server A, while project `.mcp.json` defines server P
- **THEN** P carries no disable mark in the instance's `mcp.json` and remains usable

### Requirement: Stale instance sweep

The launcher SHALL sweep stale directories under the instance root `<PI_PROFILE_SWITCH_DIR>/instances` before generating this run's instance, and SHALL only reclaim instance directories of the shape it generates; other directories under the root MUST NOT be deleted.

Whether to reclaim an instance directory SHALL be decided in this order: keep when `pid` is parseable and the process is alive (including present but unsignalable); reclaim when `pid` is parseable and the process is gone; when `pid` is missing or unparseable, reclaim only if the directory mtime is beyond the grace period.

Before classifying unrecognized entries, the launcher SHALL validate any Windows mirror manifest against the actual instance and real-agentDir entries. A manifest entry that does not validate MUST be treated as unrecognized. A valid generated hard link or directory link SHALL be treated as pi-profile-owned. A corrupt, missing, or interrupted manifest MUST NOT authorize deletion of user data.

For an instance directory judged reclaimable, the launcher SHALL examine each first-level entry not generated by pi-profile (neither a validated mirror entry, a non-Windows symbolic link, nor a managed generated artifact) and route it by content:

- If the entry is a regular file or directory whose content does not reference its own instance's path (directories are checked recursively over all their content; exceeding the scan limit counts as undecidable) and the real agentDir has no same-named entry, the launcher SHALL move it into the real agentDir (adoption) and print a one-line notice to stderr naming the entry and its destination.
- If the entry meets the conditions above but the real agentDir already has a same-named entry, the launcher SHALL delete the instance copy (the real agentDir wins) and print a one-line notice to stderr naming the entry. This branch SHALL NOT compare the two sides' content.
- If the entry's content references its own instance's path, the scan limit was exceeded so it cannot be decided, or the entry is not a regular file or directory, the launcher SHALL keep the entry and print a warning to stderr; the warning SHALL identify the directory, the unrecognized entries, and the available dispositions.

Deferred mutable files declared by a validated Windows manifest SHALL instead follow "Instance runtime-state seed" and MUST NOT enter the generic real-wins deletion branch.

Unrecognized entries inside the managed `extensions/` directory SHALL only be handled with the warning above and MUST NOT be adopted or deleted.

When any kept unrecognized entries exist, the instance directory SHALL be kept as a whole; once all unrecognized and deferred entries have been reconciled, adopted, or deleted, the directory SHALL be reclaimed.

Sweeping SHALL be best-effort: an error in a single directory MUST NOT interrupt the sweep or block startup. Instance directories SHALL NOT be deleted at exit; reclamation happens only in later launches' sweeps.

#### Scenario: Kept while pid is alive

- **WHEN** an instance directory's `pid` points at a still-running process
- **THEN** the directory is not reclaimed

#### Scenario: Reclaimed after pid exits

- **WHEN** the process an instance directory's `pid` points at no longer exists
- **THEN** the directory is reclaimed

#### Scenario: Directory without pid kept within grace period

- **WHEN** an instance directory has no `pid` file and its mtime is within the grace period
- **THEN** the directory is not reclaimed

#### Scenario: Valid Windows mirror entries are reclaimable

- **WHEN** a reclaimable Windows instance contains hard links and directory links that match its ownership manifest
- **THEN** those entries are treated as generated and the instance can be reclaimed

#### Scenario: Corrupt Windows manifest fails closed

- **WHEN** a reclaimable Windows instance has a corrupt manifest or a declared mirror entry does not match the real-agentDir entry
- **THEN** the declaration does not authorize cleanup and the entry follows the unrecognized-entry rules

#### Scenario: Kept with warning when unrecognized entries exist

- **WHEN** a reclaimable instance directory contains unrecognized entries whose content references the instance's path, that exceed the scan limit, or that are not regular files or directories
- **THEN** the directory is kept, and stderr carries a warning identifying the directory and the entries (scenario name kept from the old contract's wording; the condition has been narrowed to the non-adoptable subset)

#### Scenario: Unrecognized entry adopted into the real agentDir

- **WHEN** a reclaimable instance directory contains an unrecognized entry whose content does not reference the instance's path, and no same-named entry exists under the real agentDir
- **THEN** the entry is moved into the real agentDir with a one-line notice on stderr; when no other kept entries remain in the directory, the directory is reclaimed

#### Scenario: Instance copy deleted when the real agentDir already has the entry

- **WHEN** a reclaimable instance directory contains an unrecognized entry whose content does not reference the instance's path, but the real agentDir already has a same-named entry
- **THEN** the instance copy is deleted without content comparison, with a one-line notice on stderr; when no other kept entries remain in the directory, the directory is reclaimed

#### Scenario: Unrecognized entries inside managed directories only warn

- **WHEN** a reclaimable instance directory's managed `extensions/` directory contains an unrecognized entry
- **THEN** the entry is neither adopted nor deleted, the directory is kept, and stderr carries a warning identifying the entry

#### Scenario: Directories not of this run's shape are not deleted

- **WHEN** a directory not matching the current generation shape exists under the instance root
- **THEN** the directory is not deleted and does not affect this launch

### Requirement: Instance runtime-state seed

Before mirroring the real agentDir into the instance, the launcher SHALL preserve the state paths Pi creates at runtime so those writes can reach the real agentDir without pi-profile defining their content.

On non-Windows platforms, state directories SHALL be created under the real agentDir when missing and mirrored into the instance as symbolic links; state files SHALL use dangling symbolic links from the instance to the real-agentDir path.

On Windows, state directories SHALL be created under the real agentDir when missing and mirrored through directory links supported for an unelevated account. Existing state files SHALL share storage with the real-agentDir files. Missing state files SHALL NOT be pre-created; they SHALL be recorded as deferred mutable files and reconciled after the Pi child exits, with the next startup sweep providing recovery after interruption.

The authoritative set of seeded state paths SHALL be the constants in `src/settings-generator.ts`; this requirement MUST NOT duplicate that evolving set.

For a deferred mutable file, reconciliation SHALL atomically move or exclusively copy a newly created instance file into the real agentDir only when the target remains absent. If the target already exists with identical content, reconciliation SHALL remove the redundant instance entry. If the target exists with different content, reconciliation MUST NOT overwrite or delete either file, SHALL keep the instance directory, and SHALL emit an actionable warning identifying the conflict. Reconciliation SHALL be safe when repeated.

Paths not covered by the seed are still handled per "Stale instance sweep".

#### Scenario: Symlink established on first launch

- **WHEN** a seeded state directory does not exist under the real agentDir
- **THEN** it is created there and the instance directory entry resolves to it

#### Scenario: Not rewritten when present

- **WHEN** a seeded state directory with records already exists under the real agentDir
- **THEN** that directory's content is unchanged and the instance directory entry resolves to it

#### Scenario: Symlink established even when the target file does not exist

- **WHEN** a seeded state file is missing and the launcher runs on a non-Windows platform
- **THEN** the instance contains a dangling symbolic link to the corresponding real-agentDir path and the real file is not created by pi-profile

#### Scenario: Writes through the symlink land in the real agentDir

- **WHEN** a process writes a seeded state file through a non-Windows instance link
- **THEN** the corresponding real-agentDir file receives the content and the instance entry remains a symbolic link

#### Scenario: Windows missing state file remains absent before Pi writes

- **WHEN** a seeded state file is missing and the launcher runs on Windows
- **THEN** neither the instance nor real-agentDir file is pre-created, and the ownership manifest records deferred reconciliation

#### Scenario: Windows deferred state is reconciled after exit

- **WHEN** Pi creates a deferred state file in a Windows instance and then exits while the corresponding real-agentDir file remains absent
- **THEN** the launcher preserves the bytes in the real agentDir and the later stale-instance sweep can reclaim the instance

#### Scenario: Interrupted Windows reconciliation recovers on next launch

- **WHEN** the launcher terminates before reconciling a deferred state file
- **THEN** the next startup sweep applies the same reconciliation rules before deciding whether to reclaim the stale instance

#### Scenario: Concurrent divergent state fails closed

- **WHEN** a deferred instance state file and the corresponding real-agentDir file both exist with different content
- **THEN** neither is overwritten or deleted, the instance is kept, and the warning identifies the conflict

#### Scenario: Symlinks survive an in-place rewrite of the same instance directory

- **WHEN** the same instance directory is rewritten in place during an in-session switch
- **THEN** its seeded state entries retain their platform-appropriate sharing or deferred-reconciliation semantics
