# Why Tokless? Core Mechanics & Per-Host Setup

[Back to README](../README.en.md) | [简体中文](./why-tokless.md)

---

## 1. Why `@Codebase` or `repomix` Alone Won't Save Your Weekly Quota

Inspecting raw agent session transcripts (`transcript_full.jsonl`) reveals why quotas drain so quickly even with semantic search enabled:

| Tool Category | Examples | Primary Job | Why It Doesn't Stop Quota Drain in Agent Loops |
| :--- | :--- | :--- | :--- |
| **Semantic Search** | Built-in `@Codebase` | Finds *which files* look relevant | **Finds files, doesn't slice reads.** Agents still lazily read whole 1,500-line files (or pass `1-800` pseudo-ranges) straight into context. |
| **Full-Repo Packers** | `repomix` / `gitingest` | Packs an entire repo for web chat | Great for browser chats without file tools, but front-loads tens of thousands of tokens from turn 1 in local agent loops. |
| **Skeleton & Billing Inspector** | **`tokless`** | **Sub-100ms `[Lstart-Lend]` skeletons + opt-in guard + local billing audit** | Maps signatures and line ranges at 0 LLM tokens before reading, strips idle MCP schemas via lean roles, and audits real token bills offline. |

### The Cache Read Snowball & Model-Switch Cliffs

In multi-step agent loops, `Cumulative Cache Read ≈ Average Context Size × Model Turns`:

- **Early bloat compounds on every turn**: Dumping 30K tokens of irrelevant code on step 3 across a 50-turn session charges you 47 times—over **1.4M wasted Cache Read tokens** from one lazy read.
- **Cross-model cache cliffs**: Prefix caches are bound to specific model weights. Switching models mid-session (manually or via dual-model orchestrators sharing one conversation history) invalidates cached prefixes and rebills the history as full-price `Input` tokens (attributed automatically by `tokless audit session latest`).
- **Compaction ceilings**: Generation-3 models commonly compact around **256K tokens** (`CHECKPOINT: # Resuming from a compaction`), while Generation-4 models have been observed past 440K (estimated around **512K**). Keeping context lean preserves both memory fidelity and quota.

---

## 2. Where Each Target Installs & How to Use Day-to-Day

### Built-in One-Command Targets (`npx tokless install`)

- **Google Antigravity** (`--target agy`):
  - **Installed to**: `~/.gemini/config/plugins/agy-tokless/` (`plugin.json`, `rules/AGENTS.md`, `skills/`, `agents/`; plus `hooks.json` when `--with-guard` is passed).
  - **Usage**: Active automatically in new sessions—`code-skeleton` guides ranged reads, `tokless-coder` / `tokless-reviewer` (`agy --agent tokless-coder`) run without MCP tax, and `npx tokless audit session latest` inspects session bills.
- **Claude Code** (`--target claude`):
  - **Installed to**: `~/.claude/tokless/` + `~/.claude/skills/code-skeleton/SKILL.md`, with optional non-destructive `PreToolUse` (`Read`) hook merge in `~/.claude/settings.json` via `--with-guard`.
  - **Usage**: Discovers `code-skeleton` automatically; with `--with-guard`, unsliced reads over 800 lines receive an inline `[Lstart-Lend]` map.
- **Codex CLI** (`--target codex`):
  - **Installed to**: `~/.codex/skills/code-skeleton/` (`SKILL.md` + zero-dependency `tools/repo-skeleton`).
  - **Usage**: Discovers `code-skeleton` automatically; copy [`rules/AGENTS.md`](../rules/AGENTS.md) into your repo root `AGENTS.md` for consistent proactive triggering.

### Cursor, Windsurf, Cline, Roo Code, Trae, OpenCode & Others

1. Install globally via `npm i -g tokless` (exposes `tokless skeleton` and `tokless audit project`);
2. Copy [`rules/AGENTS.md`](../rules/AGENTS.md) into your project's root `AGENTS.md` (or `.cursor/rules/`, `.windsurfrules`, `.clinerules`, etc.).
3. Want native `npx tokless install` support for your favorite editor? See the [API & Contributing Guide](./contributing-and-api.en.md) to add a target adapter!
