# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

[Pi](https://github.com/badlogic/pi-mono) 的命名 profile 扩展。一个 profile 是你自定义的命名能力组合：skills、extensions、MCP server、tools（包括 MCP server 和 extension 提供的工具）、默认模型，以及追加到系统提示词的 instructions。在同一个运行中的 Pi 会话里切换这些组合，无需重启。

## 安装

```bash
npm install -g pi-profile-switch
```

依赖 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（作为 peer dependency 自动安装）。

在 Windows 上，profile 实例使用目录联接（junction）和文件硬链接，因此不需要开启开发人员模式或使用管理员终端。请将 `PI_PROFILE_SWITCH_DIR` 与 Pi 的真实 agent 目录放在同一个本地卷上；Windows 无法跨卷创建文件硬链接，launcher 会明确报错，而不会复制可变状态。

## 快速上手

```bash
# 使用内建 default profile 启动（全量资源，等同原生 Pi）
pi-profile

# 使用 starter 只读 ask profile 启动
pi-profile ask

# -- 后面的参数原样传给 pi
pi-profile ask -- --model openai/gpt-5.4
```

## 自定义 profile

profile 保存在两个目录中，每个 profile 对应一个独立 JSON 文件：

| 路径 | 作用域 |
| --- | --- |
| `~/.pi-profile-switch/profiles/<name>.json` | 全局，对所有项目生效。`PI_PROFILE_SWITCH_DIR` 可自定义根目录。 |
| `<项目>/.pi/profiles/<name>.json` | 项目级，仅对已信任项目生效。 |

直接编辑或新建 `<name>.json` 即可创建或修改 profile——schema 见 [`schemas/profiles.schema.json`](schemas/profiles.schema.json)。

你也可以通过对话让 agent 帮你配置：随包附带的 **`profile-config`** skill（安装时 best-effort 分发、launcher 启动时保证就位，位于 `<agentDir>/skills/profile-config/`）会指导 agent 澄清需求、发现资源并读写 profile 文件。按约定，生成声明了 `skills` 的 profile 时默认包含 `"profile-config"`（除非明确排除或已被 `*` 等 glob 覆盖），确保切换到新 profile 后仍可持续对话配置。详情见 [`skills/profile-config/SKILL.md`](skills/profile-config/SKILL.md)。

pi-profile-switch 会向全局 `profiles/` 目录播种一个初始 **`ask`** profile（`ask.json`）——安装时 best-effort、launcher 启动时保证就位——它是只读的问答与代码走读模式。它不假设你安装过任何插件，可随意修改或删除：

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

一个 profile 可以同时使用全部字段。下面这个 `impl` profile 示例（`impl.json`）加载 TDD skill、mcp-scripting skill（pi-mcp-adapter 自带）和你的内部 skills；接入两个 MCP server；tool 白名单用 glob 覆盖内建工具和这两个 server 的 MCP 工具；并钉住模型与常驻 instructions：

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

字段解析规则：

- `skills`、`extensions`、`mcps`、`tools` 接受名称或 glob（如 `"internal-*"`），引用你已安装或已配置的资源——profile 从不复制资源。已安装的包和标准目录下的文件会被自动发现，无需注册。
- `tools` 针对 Pi 的实时工具注册表展开——内建工具、extension 提供的工具，以及 MCP server 暴露的工具。MCP 工具注册为 `mcp__<server>`（代理）和 `<server>_<tool>`（直接工具，adapter 默认 `toolPrefix`），因此 `mcp__*`、`github_*` 这类 glob 可以覆盖它们。
- `mcps` 引用 pi-mcp-adapter 配置中的 server；连接细节留在 adapter 自己的配置里。
- 未写的字段保持原生 Pi 行为。

[`examples/`](examples/) 中的两个文件与上面一一对应：`ask.json` 是播种的初始 profile，`example.json` 是全字段演示。

## 命令

`/profile` 命令族完成所有会话内操作：

| 命令 | 作用 |
| --- | --- |
| `/profile` | 交互式选择 profile；无交互界面时打印 profile 列表 |
| `/profile use <name>` / `/profile reload` | 会话内切换 / 重载（失败自动回滚） |
| `/profile status` | 查看活动 profile 详情：解析后的资源与路径、已存 overlay、MCP server 三态 |
| `/profile overlay disable\|enable skill\|extension\|mcp\|tool <name-or-glob>` | 仅本次会话收窄 / 恢复活动 profile；`disable` 接受名称或 glob |
| `/profile overlay clear` | 丢弃 overlay，完全按定义重新激活 profile |

所有命令在非交互模式（`--mode rpc|print|json`）下同样生效；裸 `/profile` 在无交互界面时降级为 profile 列表。overlay 是会话级收窄：绝不写入 catalog 文件，也不会跨重启保留。tool 与其他资源类别使用相同的 disable/enable 模型：tool `disable` 条目收窄 profile 解析出的工具引用；profile 未声明 `tools` 时，则收窄运行时的全部可用工具集。

## 文档

- [架构设计](docs/architecture/overview.md) · [ADR](docs/adr/) · [术语表](CONTEXT.md)
- JSON Schema：[`schemas/`](schemas/)

## 许可证

MIT
