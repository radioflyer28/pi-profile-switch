# launcher Specification

## Purpose
Defines what the `pi-profile` launcher does before the Pi process exists: how it decides which arguments belong to the launcher and which to Pi, how the initial profile is chosen, what must fail before launch, and which project-scope content pi-profile reads.

## Requirements

### Requirement: CLI argument parsing and pass-through

The launcher's invocation form SHALL be `pi-profile [profile] [--] <pi args>...`.

The launcher SHALL consume exactly two inputs: one optional leading positional argument as the profile name (only when it does not start with `-`), and at most one `--` separator. Any `--` after that separator belongs to Pi.

All other arguments SHALL be passed verbatim to the spawned Pi process, whether or not Pi recognizes them. Positional arguments after the profile name belong to Pi.

`--approve`, `-a`, `--no-approve`, and `-na` SHALL be recognized as one-shot trust input and not passed through. When the same input recurs in contradictory forms, the last occurrence SHALL win.

#### Scenario: Positional argument and pass-through boundary

- **WHEN** launched as `pi-profile review -- --model openai/gpt-5.4 extra`
- **THEN** the profile name is `review` and Pi receives `--model openai/gpt-5.4 extra`

#### Scenario: Unknown Pi arguments pass through

- **WHEN** the user passes a flag Pi does not recognize
- **THEN** the launcher neither intercepts nor rejects it; the flag reaches Pi verbatim

#### Scenario: Trust flags are consumed, last one wins

- **WHEN** both `--approve` and `--no-approve` appear in the arguments
- **THEN** neither is passed to Pi, and the launcher takes the last one as the trust input

### Requirement: Initial profile selection

When a positional argument is given, the launcher SHALL use that name.

When no positional argument is given, the launcher SHALL try in order: the saved selection of a trusted project, the saved global selection, the built-in `default`.

When the name given by positional argument does not exist, the launcher SHALL fail before starting Pi. When a name restored from saved state no longer exists, the launcher SHALL fall back to `default` with a warning and MUST NOT block startup.

An initial selection given via CLI SHALL NOT be written to runtime state.

#### Scenario: Positional argument names an unknown profile

- **WHEN** launched as `pi-profile nosuchprofile`
- **THEN** startup fails, the error names the profile, and no Pi process is created

#### Scenario: Saved selection has gone stale

- **WHEN** no positional argument is given and the saved active profile no longer exists in the catalog
- **THEN** startup continues with `default`, printing a warning that explains the fallback

#### Scenario: Trusted project's saved selection wins

- **WHEN** no positional argument is given, the project is trusted with an active profile in project state, and global state holds a different one
- **THEN** the active profile from project state is used

### Requirement: Pre-launch failure and exit codes

The following failures SHALL abort startup before the Pi process is created: unknown profile, unresolvable references, MCP servers declared while the adapter is unavailable, illegal catalog content, illegal MCP configuration content, declared model failing validation.

The failures above SHALL exit with code `2`. Other unexpected failures SHALL exit with code `1`. Failure messages SHALL be written to stderr.

#### Scenario: Declared model not authenticated

- **WHEN** the model declared by the profile does not exist or is not authenticated
- **THEN** startup exits with code `2` and no Pi process is created

#### Scenario: Catalog content corrupt

- **WHEN** a catalog file's content is illegal
- **THEN** startup exits with code `2` and the error identifies the file path

### Requirement: Project trust gating

Project-scope content that pi-profile reads itself — the project catalog, project runtime state, project MCP configuration — SHALL be read only when the project is trusted.

The visibility of project-level resources (`.pi/skills`, `.pi/extensions`, ancestor `.agents/skills`, `.pi/prompts`, `.pi/themes`, `.pi/settings.json`) SHALL be decided by Pi's own project-trust determination. pi-profile MUST NOT narrow, attach, or exclude these resources through generated settings.

The trust determination SHALL take the first applicable result in this order: one-shot `--approve` or `--no-approve` input; a project containing no trust-requiring resources counts as trusted; the nearest ancestor's stored decision in the real `trust.json`; the user's global `defaultProjectTrust` set to `always`; otherwise untrusted.

Trust-requiring project resources SHALL include pi-profile's own project files `<projectDir>/.pi/profiles/` and `<projectDir>/.pi/pi-profile-state.json`.

The trust determination MUST NOT execute any extension code.

The trust flag recorded by the launcher SHALL be re-attached to the spawned Pi process and SHALL behave identically for every profile: one-shot trust input SHALL determine both the project catalog's readability and Pi's project-level visibility under any profile; the two MUST NOT diverge.

#### Scenario: One-shot trust input beats stored decision

- **WHEN** `trust.json` records the current project as untrusted, and this launch carries `--approve`
- **THEN** project resources are readable in this launch

#### Scenario: Named profiles forward the trust flag too

- **WHEN** launched as `pi-profile doc -- --no-approve`
- **THEN** the Pi process receives `--no-approve`, and the flag does not appear among the user arguments

#### Scenario: Project defaultProjectTrust is ask

- **WHEN** the user's global setting is `ask` and `trust.json` has no record for the current project
- **THEN** neither the project catalog nor project runtime state is read, and a named profile's project-level resources are not visible

#### Scenario: Only pi-profile's project files exist

- **WHEN** the project directory contains only a `.pi/profiles/` directory and no project resources Pi recognizes
- **THEN** the project is still judged to contain trust-requiring resources and is not auto-trusted for "having no project resources"

### Requirement: Launch diagnostic output

The launcher SHALL print non-fatal diagnostics to stderr and continue startup: extension discovery warnings, glob references with zero matches during resolution, and the untrusted-project notice.

When the project-trust determination is untrusted and the project directory contains content unavailable because of that — pi-profile's project files or any trust-requiring Pi project resources — the launcher SHALL print one diagnostic stating that the project is untrusted, which content is therefore invisible, and how to authorize: `/trust` persists the trust decision (effective on the next launch), `-- --approve` grants one-shot trust for this launch. This diagnostic SHALL behave identically for every profile, including `default`. Startup SHALL continue as usual and the exit code is unchanged.

When the project is trusted, or untrusted but contains no trust-requiring content, this diagnostic SHALL NOT be printed.

#### Scenario: Zero-match glob

- **WHEN** a glob reference in the profile matches nothing in this resolution
- **THEN** startup continues, and stderr carries a warning identifying the zero-match reference

#### Scenario: Untrusted project has skipped content

- **WHEN** the project is untrusted and trust-requiring content such as `.pi/profiles/` or `.pi/extensions` exists under the project directory
- **THEN** startup continues with an unchanged exit code, and stderr carries a diagnostic stating the project is untrusted, the invisible content, and how to authorize (`/trust` and `-- --approve`)

#### Scenario: No diagnostic for trusted projects

- **WHEN** the project is trusted
- **THEN** the untrusted-project diagnostic is not printed

#### Scenario: Untrusted but no trust-requiring content

- **WHEN** launched with `--no-approve` and the project directory contains neither trust-requiring resources nor pi-profile project files
- **THEN** the untrusted-project diagnostic is not printed

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

### Requirement: Subprocess launch

The launcher SHALL start the real Pi binary and load the pi-profile extension shipped with the package via `-e`. User arguments SHALL be appended verbatim after the extension argument.

The launcher SHALL forward the child process's exit code and forward signals to the child process.

#### Scenario: Argument order

- **WHEN** the launcher builds Pi's argv
- **THEN** the order is: extension argument, recorded one-shot trust flag (when present), user arguments

#### Scenario: Exit code forwarding

- **WHEN** the Pi child process exits with code N
- **THEN** the launcher exits with code N

### Requirement: Startup upgrade reminder

On a pi-profile launch, the system SHALL compare the running pi-profile-switch package version with the npm registry's installable `latest` tag. It SHALL show a concise upgrade reminder with the installed and target versions and the global-install command only when the target is newer and that target has not already been shown. It MUST NOT automatically install a package, show release notes, or use an announcement as the authoritative latest version. A target that is not newer, including when the running package is a prerelease ahead of `latest`, MUST NOT trigger a reminder.

#### Scenario: New stable version
- **WHEN** npm's installable `latest` is newer than the running package and has not been shown
- **THEN** one concise upgrade reminder names both versions and the global-install command, without release details

#### Scenario: Already shown target
- **WHEN** a later launch sees the same target version after its upgrade reminder was displayed
- **THEN** the ordinary upgrade reminder is not displayed again, regardless of the selected profile or project

#### Scenario: No newer installable version
- **WHEN** the running package is at or ahead of npm's installable `latest`
- **THEN** no ordinary upgrade reminder is displayed

### Requirement: Applicable startup announcements

The system SHALL retrieve a single maintainer-published `announcements.json` feed. It SHALL display a concise announcement only if its identifier is unique, its content is valid and bounded, it applies to the running package version, it has not expired, and that identifier has not been displayed before. An announcement SHALL supply its own action text; a details document or link MUST NOT be required. An announcement explicitly requiring an upgrade SHALL replace the ordinary upgrade reminder in the same launch. The remote feed MUST NOT control execution, install packages, alter profile behavior, or add text to the agent's prompts.

#### Scenario: Applicable first-time announcement
- **WHEN** an unexpired, valid announcement applies to the installed version and its identifier has not been displayed
- **THEN** its concise message and action are displayed and the identifier is recorded for subsequent launches

#### Scenario: Wrong version or expired announcement
- **WHEN** an announcement does not apply to the installed version or has passed its expiry
- **THEN** it is not displayed, including when it came from a locally cached response

#### Scenario: Upgrade action takes precedence
- **WHEN** an applicable announcement explicitly requires an upgrade and a newer installable version is known
- **THEN** the announcement is displayed and the ordinary upgrade reminder is suppressed for that launch

#### Scenario: Untrusted instructions in announcement text
- **WHEN** an announcement body contains instructions to alter the agent's behavior
- **THEN** it remains notification text only and does not enter the agent's system prompt or command execution path

### Requirement: Best-effort remote checks and global history

Remote checks SHALL use a bounded duration and SHALL NOT delay Pi startup, change its exit code, or prevent profile activation. Remote results SHALL be refreshed no more often than once per day per source during normal operation; cache and displayed-history SHALL survive separate launches and SHALL be shared across profiles and projects, not stored in project content or a reclaimable instance directory. In offline operation or when a remote request fails, the system SHALL use previously validated cached results if available and SHALL otherwise omit the notification. Invalid remote content MUST NOT replace a valid cache and SHALL produce a bounded diagnostic identifying the failing source; expected offline or network failures MUST NOT spam users. A request still pending when Pi exits MUST NOT keep the process alive just to finish a check.

#### Scenario: Cache reuse
- **WHEN** a second launch happens before the refresh interval elapses
- **THEN** no new remote request is required and the locally cached data is used

#### Scenario: Offline launch
- **WHEN** the existing Pi offline mode is enabled or remote access is unavailable at launch
- **THEN** Pi starts normally, using previously validated cached results when available and otherwise showing no remote notice; explicit offline mode does not initiate remote requests

#### Scenario: Invalid announcement feed
- **WHEN** the remote announcement response is malformed or violates the announcement limits
- **THEN** previously valid cached announcements remain usable and the failure produces a bounded, actionable diagnostic without blocking startup

#### Scenario: Slow network and short-lived process
- **WHEN** a remote check has not completed by the time a non-interactive Pi process exits
- **THEN** the process exits without waiting for that check; a later launch can use successfully cached information

### Requirement: Startup-only mode-safe delivery

Startup notices SHALL be presented in Pi's interactive UI when available and on stderr in non-interactive modes. They MUST NOT be written to stdout, inserted into structured Pi output, or injected into the agent's prompts. The notice check SHALL run once per Pi process launch, not again on session reload, profile switching, new, resume, or fork. The notifier SHALL behave the same for the `default` and named profiles and MUST NOT change their resource selection, trust determination, Pi arguments, settings, or session behavior.

#### Scenario: Interactive launch
- **WHEN** an eligible notice is available during an interactive Pi launch
- **THEN** it appears as an in-session notification rather than only in pre-TUI launcher output

#### Scenario: Non-interactive launch
- **WHEN** an eligible notice is available in a non-interactive mode
- **THEN** it is printed only to stderr and stdout retains Pi's native output format

#### Scenario: Profile reload does not rerun notices
- **WHEN** a notice has been considered and the same Pi process reloads or switches profiles
- **THEN** no second startup notice check or display is triggered by that session event
