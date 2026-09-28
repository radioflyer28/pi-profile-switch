# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

Named profiles for [Pi](https://github.com/badlogic/pi-mono). A profile is a named set of resources you define: skills, extensions, MCP servers, tools (including tools exposed by MCP servers and extensions), model defaults, and extra system-prompt instructions. Switch profiles inside a running Pi session — no restart.

## Install

```bash
npm install -g pi-profile-switch
```

Requires [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (installed automatically as a peer dependency).

On Windows, profile instances use directory junctions and file hard links, so Developer Mode and an elevated shell are not required. Keep `PI_PROFILE_SWITCH_DIR` on the same local volume as Pi's real agent directory; Windows cannot hard-link existing files across volumes, and the launcher fails clearly rather than copying mutable state.

## Quick start

```bash
# Launch with the built-in default profile (all resources, plain Pi behavior)
pi-profile

# Launch with the seeded read-only ask profile
pi-profile ask

# Anything after -- is passed to pi verbatim
pi-profile ask -- --model openai/gpt-5.4
```

## Define your own profiles

Profiles live in two directories, with one JSON file per profile:

| Path | Scope |
| --- | --- |
| `~/.pi-profile-switch/profiles/<name>.json` | Global, all projects. `PI_PROFILE_SWITCH_DIR` overrides the workspace root. |
| `<project>/.pi/profiles/<name>.json` | Project-level, trusted projects only. |

Create or change a profile by editing or creating a `<name>.json` file directly — schema: [`schemas/profiles.schema.json`](schemas/profiles.schema.json).

You can also configure profiles conversationally: the package ships a **`profile-config`** skill (distributed to `<agentDir>/skills/profile-config/` — best-effort on install, and guaranteed in place at every launcher startup) that guides the agent to clarify requirements, discover resources, and write or remove profile files. Profiles created with a `skills` list include `"profile-config"` by default (unless explicitly opted out or covered by a wildcard like `"*"`), keeping configuration available after switching. Details: [`skills/profile-config/SKILL.md`](skills/profile-config/SKILL.md).

pi-profile-switch seeds the global `profiles/` directory with a starter **`ask`** profile (`ask.json`) — best-effort on install, and guaranteed in place at every launcher startup — read-only Q&A and code exploration. It assumes nothing about your setup; edit or delete it freely:

```json
{
  "label": "Ask & Discuss",
  "description": "Read-only Q&A and code exploration; no file modifications or command execution",
  "skills": [],
  "extensions": [],
  "tools": ["read", "grep", "find", "ls"],
  "instructions": "You are in read-only discussion mode. Answer questions and explain code without modifying any files or running shell commands."
}
```

One profile can use every field at once. This example `impl` profile (`impl.json`) loads the TDD skill, the mcp-scripting skill (shipped by pi-mcp-adapter), and your internal skills; wires up two MCP servers; allows the built-in tools plus both servers' MCP tools by glob; and pins the model and standing instructions:

```json
{
  "label": "Implementation",
  "description": "Full-powered implementation profile: every available field, pinned model",
  "skills": [
    "tdd",
    "internal-*",
    "mcp-scripting"
  ],
  "extensions": [
    "pi-mcp-adapter"
  ],
  "mcps": [
    "github",
    "linear"
  ],
  "tools": [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "mcp__*",
    "github_*",
    "linear_*"
  ],
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high",
  "instructions": "Prefer small, verifiable changes. Run the test suite before claiming completion."
}
```

How fields resolve:

- `skills`, `extensions`, `mcps`, `tools` take names or globs (e.g. `"internal-*"`) referencing resources you already installed or configured — profiles never copy them. Installed packages and files in standard locations are discovered automatically; no registration needed.
- `tools` expands against Pi's live tool registry — built-ins, extension-provided tools, and tools exposed by MCP servers. MCP tools are registered as `mcp__<server>` (proxy) and `<server>_<tool>` (direct tools, the adapter's default `toolPrefix`), so globs like `mcp__*` and `github_*` cover them.
- `mcps` references servers from your pi-mcp-adapter configuration; connection details stay in the adapter's own config.
- Any field you omit keeps plain Pi behavior.

The files in [`examples/`](examples/) mirror the two profiles above: `ask.json` is the seeded starter, `example.json` the full-field demo.

## Commands

The `/profile` command family manages everything in-session:

| Command | What it does |
| --- | --- |
| `/profile` | Interactive profile picker; without interactive UI it prints the profile list instead |
| `/profile use <name>` / `/profile reload` | Switch / reload without restarting (rollback on failure) |
| `/profile status` | Active profile details: resolved resources and paths, stored overlay, MCP server tri-state |
| `/profile overlay disable\|enable skill\|extension\|mcp\|tool <name-or-glob>` | Narrow / un-narrow the active profile for this session only; `disable` entries accept names or globs |
| `/profile overlay clear` | Discard the overlay and reactivate the profile exactly as declared |

All forms work in every mode, including non-interactive ones (`--mode rpc|print|json`); the bare selector degrades to the profile list where no interactive UI exists. The overlay is a runtime-only narrowing: it is never written to a catalog file and never survives a restart. Tools follow the same disable/enable model as the other resource kinds: a tool `disable` entry narrows the profile's resolved tool references — or the runtime's full available tool set when the profile declares no `tools`.

## Docs

- [Architecture](docs/architecture/overview.md) · [ADRs](docs/adr/) · [Glossary](CONTEXT.md)
- JSON Schemas: [`schemas/`](schemas/)

## License

MIT
