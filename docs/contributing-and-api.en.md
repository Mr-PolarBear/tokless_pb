# Programmatic Node.js API & Contributing Guide

[Back to README](../README.en.md) | [简体中文](./contributing-and-api.md)

---

## 1. Programmatic Node.js API

`tokless` exports zero-dependency CommonJS modules (`tokless`, `tokless/skeleton`, `tokless/read-guard`, `tokless/audit`) for in-process agent harnesses and evaluation scripts with zero child-process overhead:

```js
const {
  generateSkeleton,        // File or directory [Lstart-Lend] map (supports depth / exclude / map / symbol)
  sliceSymbol,             // Drift-proof source slice by function/method/section name (with typo fallback)
  locateSymbol,            // Resolve live [startLine, endLine] metadata for a symbol without body text
  evaluateReadGuard,       // Pure validator for Antigravity / Claude Code PreToolUse payloads
  listSessions,            // List recent Antigravity sessions (source: 'cli' | 'app' | 'ide' | 'all')
  analyzeSession,          // Dissect session billing, model-switch cache cliffs & peak context ('latest')
  compareSessions,         // A/B compare two sessions ('latest~1', 'latest')
  auditProject,            // Inspect project rules, skills & MCP/tool schema base token costs
} = require('tokless');

// 1. Extract [Lstart-Lend] map for a directory with custom excludes
const skel = generateSkeleton('./src', { depth: 2, exclude: ['third_party', 'vendor'] });
console.log(skel.formatted);

// 2. Slice exact function/class method/Markdown section by symbol name
const slice = sliceSymbol('./src/server.ts#Server.start', undefined, { lineNumbers: true });
console.log(slice.formatted);

// 3. Evaluate PreToolUse payloads in memory
const verdict = evaluateReadGuard({
  tool_name: 'Read',
  tool_input: { file_path: './src/large-module.ts' },
});
// => { decision: 'deny' | 'allow', reason?: string, host: 'claude' | 'antigravity' }
```

---

## 2. Contributing Host Targets & Language Parsers

### Host Agent Installers (`targets/<agent>.js`)

Host integrations live as self-contained adapters under [`targets/`](../targets/):

- [`targets/antigravity.js`](../targets/antigravity.js) — Google Antigravity plugin, hooks, and lean roles
- [`targets/claude-code.js`](../targets/claude-code.js) — Claude Code `~/.claude/settings.json` non-destructive hook merge + skill (**recommended template for new adapters**)
- [`targets/codex.js`](../targets/codex.js) — OpenAI Codex CLI skill installer

To add a new host target (e.g. Cursor, Windsurf, Cline, Roo Code, Trae, OpenCode, GitHub Copilot):
1. Export `{ id, aliases, label, detect(options), install(options), uninstall(options) }` using `resolveHomeDir(options)` from [`targets/shared.js`](../targets/shared.js) (never hardcode `os.homedir()`);
2. Register the adapter in [`targets/index.js`](../targets/index.js) and add isolated-home install/reinstall/uninstall tests in [`tests/verify-tokless.js`](../tests/verify-tokless.js).

### Language Skeleton Parsers (`tools/repo-skeleton/lib/langs/<lang>/`)

Every language lives under [`tools/repo-skeleton/lib/langs/<lang>/index.js`](../tools/repo-skeleton/lib/langs/) backed by [`tools/repo-skeleton/lib/core/`](../tools/repo-skeleton/lib/core/), lazy-loaded on demand by [`core/registry.js`](../tools/repo-skeleton/lib/core/registry.js) only when matching file extensions are scanned.

1. Update or add `tools/repo-skeleton/lib/langs/<lang>/index.js` (and register new extensions in `LANG_DIR_TO_EXTS` inside `core/registry.js`);
2. Add regression tests in `tests/langs/<lang>.test.js` (auto-discovered by [`tests/run-all.js`](../tests/run-all.js));
3. Verify locally before opening a PR:

```bash
npm test
npm pack --dry-run
```

See [`AGENTS.md`](../AGENTS.md) at the repository root for the full change-impact sync map and engineering invariants.
