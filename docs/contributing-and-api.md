# Node.js 编程接口与社区扩展指南（API & Contributing）

[返回主文档 (README.md)](../README.md) | [English](./contributing-and-api.en.md)

---

## 一、Node.js 编程接口（Programmatic API）

`tokless` 导出零依赖标准 CommonJS 接口（支持 `tokless`、`tokless/skeleton`、`tokless/read-guard`、`tokless/audit` 子路径按需引入），方便 Agent 编排器或评测脚本在进程内直接调用，零子进程开销：

```js
const {
  generateSkeleton,        // 自动识别文件或目录生成 [L起-L止] 骨架（支持 depth / exclude / map / symbol / respectGitignore）
  sliceSymbol,             // 按符号/类方法/章节名精准切片源码，支持单文件与跨目录（选项: lineNumbers / depth / exclude / all / respectGitignore）
  locateSymbol,            // 定位单文件或跨目录符号当前起止行号区间（支持 depth / exclude / respectGitignore，不拉取源码正文）
  walkDirectory,           // 共用目录遍历器（遵守 .gitignore 分层过滤与显式指向忽略目录穿透放行，支持 depth / exclude / extensions / respectGitignore）
  evaluateReadGuard,       // 纯函数评估 Antigravity / Claude Code 读取请求是否无行号盲读
  listSessions,            // 列出本地 Antigravity 会话（支持 source: 'cli' | 'app' | 'ide' | 'all'）
  analyzeSession,          // 解析单次会话账单、模型切换缓存断层与峰值水位（支持 'latest'）
  compareSessions,         // 对比两个会话的前后量化账单（支持 'latest~1', 'latest'）
  auditProject,            // 透视项目常驻规则、Skill 与 MCP / 工具底座 Token 账单
} = require('tokless');

// 1. 提取目录或单文件骨架（自动遵守 .gitignore，支持自定义排除目录）
const skel = generateSkeleton('./src', { depth: 2, exclude: ['third_party', 'vendor'] });
console.log(skel.formatted);

// 2. 按符号/类方法/章节名精准切片或定位（支持单文件或目录 "<file-or-dir>#<symbol>" 及独立 symbol 参数）
const fileSlice = sliceSymbol('./src/server.ts#Server.start', undefined, { lineNumbers: true });
const dirSlice = sliceSymbol('./src#Server.start', undefined, { depth: 4, exclude: ['fixtures'], all: false, lineNumbers: true });
const located = locateSymbol('./src', 'Server.start', { depth: 4, exclude: ['fixtures'] });
console.log(fileSlice.formatted, dirSlice.formatted, located.matches);

// 3. 复用共用目录遍历器（自动读取各层 .gitignore，显式指向忽略目录时自动放行）
const walked = walkDirectory('./src', { depth: 3, exclude: ['fixtures'], respectGitignore: true });
// walked => { root, maxDepth, gitRoot, penetrated, files }

// 4. 进程内调用防盲读判定（支持 Antigravity 与 Claude Code 载荷格式）
const verdict = evaluateReadGuard({
  tool_name: 'Read',
  tool_input: { file_path: './src/large-module.ts' },
});
// verdict => { decision: 'deny' | 'allow', reason?: string, host: 'claude' | 'antigravity' }
```

---

## 二、社区共建：扩展更多 AI 工具与语言支持

### 1. 新增 AI 编程工具一键挂载（`targets/<agent>.js`）

各宿主的安装与卸载逻辑完全解耦在 [`targets/`](../targets/) 目录下，每个宿主只需一个独立的百行级适配器文件：

- [`targets/antigravity.js`](../targets/antigravity.js) — Google Antigravity 插件、钩子与净身角色挂载
- [`targets/claude-code.js`](../targets/claude-code.js) — Claude Code `~/.claude/settings.json` 无损合并与技能挂载（**推荐新增适配时优先参考**）
- [`targets/codex.js`](../targets/codex.js) — OpenAI Codex CLI 技能挂载

新增宿主步骤：
1. 参考 [`targets/claude-code.js`](../targets/claude-code.js) 与 [`targets/shared.js`](../targets/shared.js)，导出 `{ id, aliases, label, detect(options), install(options), uninstall(options) }`（通过 `resolveHomeDir(options)` 获取主目录，支持沙箱测试注入，不写死 `os.homedir()`）；
2. 在 [`targets/index.js`](../targets/index.js) 注册，并在 [`tests/verify-tokless.js`](../tests/verify-tokless.js) 补齐隔离 `HOME` 下的安装、幂等重装与干净卸载测试。

### 2. 多语言骨架解析扩展与边界修复（`tools/repo-skeleton/lib/langs/<lang>/`）

`tokless skeleton` 采用「共享词法与括号平衡核心（[`tools/repo-skeleton/lib/core/`](../tools/repo-skeleton/lib/core/)）+ 按语言分目录惰性加载（[`tools/repo-skeleton/lib/langs/<lang>/index.js`](../tools/repo-skeleton/lib/langs/)）」架构：

- 每种语言在独立目录内管理关联后缀（如 `javascript/`、`c-family/`、`java/`、`kotlin/`、`python/`、`go/`、`rust/`、`sfc/`、`markdown/`），仅在扫描到对应后缀时由 [`core/registry.js`](../tools/repo-skeleton/lib/core/registry.js) 按需加载，保持毫秒级冷启动。
- 修复语法边界漏检或新增语言时：
  1. 修改或新增 `tools/repo-skeleton/lib/langs/<lang>/index.js`（新增后缀同步注册至 `core/registry.js` 的 `LANG_DIR_TO_EXTS`）；
  2. 在 `tests/langs/<lang>.test.js` 补上复现该场景的回归单测（[`tests/run-all.js`](../tests/run-all.js) 自动递归发现全部 `*.test.js`）；
  3. 提交 PR 前运行全套门禁自检：

```bash
npm test
npm pack --dry-run
```

完整仓库协作与文档同步约定参见根目录 [`AGENTS.md`](../AGENTS.md)。
