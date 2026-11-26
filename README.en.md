> [!NOTE]
> **Fork Enhancements (synced with upstream [daoif/tokless](https://github.com/daoif/tokless) main)**
>
> *Earlier Java nested-class/generic/annotation and JS IIFE fixes from this fork have been merged into upstream's modular lexer parsers and are no longer fork-only.*
>
> On top of upstream `tokless`, this fork adds **Antigravity Live Session Context Monitoring**:
> 1. **Zero-Dependency Live Telemetry (`tools/agy-audit/lib/live-metrics.js`)**: Reads `conversations/<id>.db` Protobuf nanosecond timestamps and native token splits (with SQLite WAL tail catch-up) at 0 LLM token cost—showing real-time context watermark (`Xk/512k`, instant drop after `/compact`), average cache hit rate, streaming/E2E `tok/s`, TTFT, thinking vs. response split, and recent turns.
> 2. **Official Sidecar Panel + Per-Reply Pill (`sidecars/tokless_monitor/` + `rules/AGENTS.md`)**: Appends a native `[📊 Tokless 实时监控](sidecar://agy-tokless/tokless_monitor/)` toggle pill to open/close the 2.5s auto-refreshing Sidecar pane (with `mtimeMs` backend hot-reload), surviving Antigravity client updates.
> 3. **Windows Reinstall Resilience (`targets/antigravity.js`)**: Patches absolute `node` path into `sidecar.json`, gracefully falls back to in-place overwrite on Windows `EBUSY` sidecar locks, and preserves upstream `--with-guard` opt-in semantics.
> 4. **Local Install**: Clone this fork and run `node install.js --target agy --copy` (covered by `tests/live-monitor.test.js` in `npm test`).

<p align="left">
  <img src="./assets/logo.svg" width="60" height="60" alt="Tokless Logo" />
</p>

# Tokless

[![License: MIT](https://img.shields.io/badge/License-MIT-18181B.svg)](./LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-10B981.svg)](./package.json)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-18181B.svg)](./package.json)

[简体中文](./README.md) | English

> **Cut runaway prompt-cache snowballing and blind-read token bloat in half—without sacrificing a single line of debugging or coding quality.**

`tokless` is a **zero-dependency Node.js (`>=18`)** token optimizer and local billing inspector built for AI coding agents (one-command native setup for **Google Antigravity**, **Claude Code**, and **Codex CLI**, plus universal CLI/rules for Cursor, Windsurf, Cline, Roo Code, and others):

1. **Stop Blind-Read Bloat (`tokless skeleton` / `tokless slice`)**: Semantic search (`@Codebase`) finds files, not line ranges—agents still lazily read entire 1,500-line files into context, compounding `Cache Read` costs on every subsequent turn. `tokless` extracts function/class/macro/typedef signatures with exact **`[Lstart-Lend]` line ranges** in milliseconds and slices functions, class methods, or Markdown sections directly by symbol name (**85%~97% exploration savings**).
2. **Strip Idle MCP Base Tax (`tokless-coder` / `tokless-reviewer`)**: Lean roles with `inheritMcp: false` strip unused external MCP and tool schemas during pure coding or read-only review sessions.
3. **Inspect Real Token Bills Offline (`tokless audit`)**: Dissect Top 5 costliest steps, Prefix Cache cliffs (including Orchestrator/dual-model switches and idle expirations), and project rule/MCP base overhead at **0 LLM tokens**.

---

## Real-World A/B Benchmark (Tauri + Rust + React Bug Hunt & Fix)

Two isolated Git worktrees from commit `3908815`, running the exact same model and prompt across a production desktop codebase:

| Metric | Baseline (Default Agent) | With `tokless` | Delta |
| :--- | :--- | :--- | :--- |
| **Total Tokens (`input + cache_read + output`)** | 21,410,381 | **10,029,592** | **-53.2% (-11.38M)** |
| **Cumulative Cache Read Tokens** | 20,858,589 | **9,627,700** | **-53.8% (-11.23M)** |
| **Model Turns / Execution Steps** | 64 turns / 220 steps | **42 turns / 150 steps** | **-34.4% turns** |
| **`read_file` Calls (Unsliced Blind Reads)** | 79 (3 blind reads) | **51 (0 blind reads)** | **-35.4% reads** |
| **Peak Context Watermark** | 439,830 tokens | **323,344 tokens** | **-26.5% peak** |
| **Real Bugs Found & Fixed (Build Verified)** | 7 | **7** | **Zero quality loss** |

> *Note: Recorded on the `v0.1.0` baseline (skeleton + blind-read block only); newer releases add MCP-stripped lean roles, deep C/C++ parsing, and refined line-range pass-through. Full reports: [real-world-bugfix-case.md](./benchmarks/real-world-bugfix-case.md) and [static-skeleton-benchmark.md](./benchmarks/static-skeleton-benchmark.md).*

---

## Quick Install

Auto-detects and installs skills, rules, and lean roles into Google Antigravity, Claude Code (`~/.claude`), and Codex CLI (`~/.codex`). **Omits `PreToolUse` child-process hooks by default** for zero read latency (automatically copies files when invoked via `npx`):

```bash
npx tokless install
```

Opt in to the `>800`-line unsliced blind-read guard, target specific hosts, or cleanly uninstall anytime:

```bash
npx tokless install --with-guard       # Opt-in PreToolUse hook (returns skeleton only on unsliced reads >800 lines)
npx tokless install --target agy       # Target agy, claude, codex, or all
npx tokless uninstall --target all     # Cleanly remove and restore original host settings
```

Or paste one prompt straight into your AI coding agent:

```text
Please run `npx tokless install` to enable tokless and confirm that the skills and lean-reading rules are active.
```

> **Using Cursor, Windsurf, Cline, Roo Code, Trae, or OpenCode?**
> Run `npm i -g tokless` and copy [`rules/AGENTS.md`](./rules/AGENTS.md) into your repository root `AGENTS.md` (or editor rule file). See [Core Mechanics & Per-Host Setup](./docs/why-tokless.en.md) for details.

---

## Core Capabilities & Everyday CLI

| Host Agent | 1. `tokless skeleton` | 2. `PreToolUse` Guard (`--with-guard`) | 3. Lean Roles (`inheritMcp: false`) | 4. `tokless audit` Inspector |
| :--- | :---: | :---: | :---: | :---: |
| **Google Antigravity** | Native Skill + CLI + `rules/AGENTS.md` | Optional `hooks.json` (`>800`-line navigator) | `tokless-coder` / `tokless-reviewer` | Full (`project` + `list / session / compare`) |
| **Claude Code** | `~/.claude/skills` + CLI | Optional merged `~/.claude/settings.json` | — | `audit project` (rules & MCP cost) |
| **Codex CLI** | `~/.codex/skills` + CLI + `AGENTS.md` | — | — | `audit project` (rules cost) |
| **Other Coding Agents** | `npm i -g tokless` + root `AGENTS.md` | PRs welcome via `targets/` | — | `audit project` (rules cost) |

```bash
# 1. Code skeletons & symbol slicing (lazy-loads JS/TS, Vue/Svelte, Python, Go, Rust, Java, Kotlin, C/C++, C#, Markdown)
npx tokless skeleton . --map                                    # Fast repo file line/char overview
npx tokless skeleton ./src --depth 3 --exclude third_party      # Directory [Lstart-Lend] signature map
npx tokless skeleton ./driver/hal_uart.c                        # Single file or large C/C++ header skeleton
npx tokless slice ./src/server.ts#Server.start --line-numbers   # Drift-proof slice by symbol/method/section (with typo suggestions)

# 2. Offline 0-LLM-token billing & base-tax audits
npx tokless audit project .                                     # [Universal] Inspect Always-On rules, skills & MCP base costs
npx tokless audit list --source cli                             # [Antigravity] List recent sessions (cli / app / ide / all)
npx tokless audit session latest                                # [Antigravity] Dissect Top 5 costliest steps & cache cliffs
npx tokless audit compare latest~1 latest                       # [Antigravity] Side-by-side A/B session bill comparison
```

---

## Documentation & Contributing

- **[Why `@Codebase` / `repomix` Alone Isn't Enough & Per-Host Paths](./docs/why-tokless.en.md)**
- **[Programmatic Node.js API & Contributing Host/Language Adapters](./docs/contributing-and-api.en.md)**
- **[Repository Engineering Guide & Change-Sync Map (AGENTS.md)](./AGENTS.md)**

---

## Acknowledgments

Built from scratch on the Node.js standard library. Special thanks to:

- **Contributors**: [@PXY000](https://github.com/PXY000) (cross-platform PowerShell skill templates, absolute Node resolution in hooks, path traversal guards & tests), [@Mr-PolarBear](https://github.com/Mr-PolarBear) (Java nested classes, dotted/generic return types, anonymous field filtering & JS top-level IIFE fixes), and [@Jefferyu](https://github.com/Jefferyu) (modular C/C++ embedded skeleton parser, multi-source Antigravity CLI audit, Pure-Lazy MCP tax calibration & dual-model/short-window cache cliff attribution).
- **Open-Source Inspiration**: [HoangP8/tokless](https://github.com/HoangP8/tokless), [ILoveMyJay/repocontext](https://github.com/ILoveMyJay/repocontext), [pdavis68/RepoMapper](https://github.com/pdavis68/RepoMapper), and [ooples/token-optimizer-mcp](https://github.com/ooples/token-optimizer-mcp).

## License

[MIT](./LICENSE)
