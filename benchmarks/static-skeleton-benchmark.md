# `agy-tokless` + `repo-skeleton` 实测与对比基准报告

> 测试环境：Windows (`pwsh`) · Node.js `v20.19.5` · 零第三方编译依赖

---

## 1. 测试对象与工具链

- **骨架提取 CLI**：[cli.js](../tools/repo-skeleton/cli.js) + [skeleton.js](../tools/repo-skeleton/lib/skeleton.js)
- **PreToolUse 拦截钩子**：[read-guard-hook.js](../scripts/read-guard-hook.js)（由 [hooks.json](../hooks.json) 挂载）
- **真实超 200 行测试样本**：
  - `./sample-repo/tools/session-export/lib/parser.js`（297 行）
  - `./sample-repo/tools/claude-export/lib/parser.js`（257 行）
  - `./tools/repo-skeleton/lib/skeleton.js`（1426 行）
  - 目录级扫描：`./sample-repo/tools --depth 2`（20 个代码文件）

---

## 2. `repo-skeleton` Token 压缩与耗时对比

| 测试目标 | 总行数 | 全文估算 Token | 骨架行数 | 骨架估算 Token | Token 节省率 | 提取耗时 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `session-export/lib/parser.js` | 297 | 2,750 | 4 | 61 | **97.8%** | 11.86 ms（JSON: 12.63 ms） |
| `claude-export/lib/parser.js` | 257 | 2,121 | 3 | 41 | **98.1%** | 9.58 ms |
| `repo-skeleton/lib/skeleton.js` | 1,426 | 10,662 | 18 | 278 | **97.4%** | 33.72 ms |
| `./sample-repo/tools` (`--depth 2`) | 3,909（20 文件） | 36,293 | — | 1,262 | **96.5%** | 90.74 ms |

### 单文件实测输出样本（`session-export/lib/parser.js`）

执行命令：

```bash
node ./tools/repo-skeleton/cli.js ./sample-repo/tools/session-export/lib/parser.js
```

实测输出：

```text
文件: ./sample-repo/tools/session-export/lib/parser.js
统计: 总行数 297 行 | 全文估算 2750 tokens → 骨架估算 61 tokens (节省 97.8%, 耗时 11.86ms)
---
[L10-L29] function extractCleanUserPrompt(raw)
[L35-L81] function readLogEvents(logPath)
[L87-L291] function parseSession(sessionIdOrPath)
[L293-L297] module.exports = { extractCleanUserPrompt, readLogEvents, parseSession }
```

> 注：如果只需要修改 `readLogEvents`，拿到骨架后通过 `read_file(Path, StartLine=35, EndLine=81)` 仅读取 47 行即可，避免把 297 行全文（约 2,750 tokens）塞入上下文并在后续多轮对话中持续产生 Cache Read 消耗。

---

## 3. `PreToolUse` 钩子拦截与放行实测

在仓库根目录（`./`）下模拟 Antigravity `PreToolUse` 标准输入管道调用 `node ./scripts/read-guard-hook.js`：

| 用例 | 输入关键参数 | 预期决策 | 实测结果 | 端到端进程耗时 |
| :--- | :--- | :---: | :---: | ---: |
| 1. 无行号全量读取 >200 行 JS 文件 | `name: "read_file"`, `Path: "./sample-repo/tools/session-export/lib/parser.js"`（无 `StartLine`/`EndLine`） | `deny` | `deny`（附带 4 条 `[L起-L止]` 骨架） | 133.36 ms |
| 2. 带 `StartLine` 与 `EndLine` 精准读取 | `name: "read_file"`, `StartLine: 35, EndLine: 81` | `allow` | `{"decision":"allow"}` | 98.42 ms |
| 3. 仅带 `StartLine` | `name: "read_file"`, `StartLine: 10` | `allow` | `{"decision":"allow"}` | — |
| 4. 小代码文件（≤ 200 行） | `name: "read_file"`, `Path: "./tools/repo-skeleton/cli.js"`（123 行） | `allow` | `{"decision":"allow"}` | — |
| 5. 非代码文件（`.md`） | `name: "read_file"`, `Path: "./rules/AGENTS.md"` | `allow` | `{"decision":"allow"}` | — |
| 6. `view_file` 无行号读取 >200 行文件 | `name: "view_file"`, `Path: "./sample-repo/tools/claude-export/lib/parser.js"`（257 行） | `deny` | `deny`（附带 3 条 `[L起-L止]` 骨架） | — |
| 7. 环境变量覆盖阈值 `AGY_READ_MAX_LINES=100` | `Path: "./tools/repo-skeleton/cli.js"`（123 行 > 100） | `deny` | `deny`（提示超过 100 行阈值并附带骨架） | — |
| 8. 非法 JSON 异常兜底 | `{bad json` | `allow` | `{"decision":"allow"}` | — |

### 拦截场景实测输出原文（Case 1）

输入 JSON：

```json
{"toolCall":{"id":"tc1","name":"read_file","args":{"Path":"./sample-repo/tools/session-export/lib/parser.js"}}}
```

钩子 `stdout` 返回：

```json
{"decision":"deny","reason":"⚡ [agy-tokless 省流护栏] 目标文件共 297 行（超过 200 行全量读取阈值），已拦截盲目全量读取以保护上下文额度。\n请根据下方该文件的语法骨架与 [L起-L止] 行号范围，重新调用 read_file 并传入 StartLine 和 EndLine 精准读取所需片段：\n\n[L10-L29] function extractCleanUserPrompt(raw)\n[L35-L81] function readLogEvents(logPath)\n[L87-L291] function parseSession(sessionIdOrPath)\n[L293-L297] module.exports = { extractCleanUserPrompt, readLogEvents, parseSession }"}
```

### 精准读取放行实测输出原文（Case 2）

输入 JSON：

```json
{"toolCall":{"id":"tc2","name":"read_file","args":{"Path":"./sample-repo/tools/session-export/lib/parser.js","StartLine":87,"EndLine":150}}}
```

钩子 `stdout` 返回：

```json
{"decision":"allow"}
```
