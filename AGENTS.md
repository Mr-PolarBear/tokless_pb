# Tokless Repository Guide for AI Coding Agents (AGENTS.md)

本文件供开发、维护或向 `tokless` 提 PR 的 AI 助手阅读（`rules/AGENTS.md` 为安装到用户项目的省流规则模板，勿混淆）。

> **开源纯净与本地配置约定**：本仓库为公开开源项目，任何受跟踪文档、代码注释与测试用例中严禁写入内部商业标签、私人业务定位或闭源/私有项目信息；进入本目录开发或准备发版前，若本地存在已 `.gitignore` 忽略的 `AGENTS.local.md`，必须先读取它以获取本机私有配置与发布约定。

## 1. 项目定位

`tokless`（GitHub `daoif/tokless` / NPM `tokless`）是面向通用 AI 编程 Agent（Antigravity, Claude Code, Codex, Cursor, Windsurf, Cline, Roo Code, Trae, OpenCode, GitHub Copilot 等）的 **纯 Node.js 标准库（`>=18`）零第三方依赖** Token 节约与上下文账单透视开源套件，聚焦解决大文件盲读膨胀、长对话上下文滚雪球与隐式压缩失忆问题，并通过解耦的 `targets/` 与 `langs/` 扩展接口支持多宿主与多语言社区共建。

## 2. 目录职责边界

- `tools/repo-skeleton/`、`lib/skeleton.js` & `lib/slice.js`：多语言类名/函数签名/类型定义/宏区间与 `[L起-L止]` 行号骨架提取器（兼容 `repo-skeleton`，支持总行数/总字数统计与 `--map` 全仓体量鸟瞰），以及 `tokless slice` 单文件与跨目录按符号切片引擎；内置 `lib/core/`（配置化文本块词法器、括号平衡倒推扫描，以及支持 `.gitignore` 分层过滤与显式指向忽略目录自动穿透放行的共用目录遍历器 `dir-walker.js`）和 `lib/langs/<lang>/` 按语言目录惰性解析器。
- `scripts/read-guard-hook.js` & `lib/read-guard.js`：可选 `PreToolUse` 盲读导航钩子（默认关闭，`--with-guard` 启用；仅对 `>800` 行无行号/无字节偏移盲读返回骨架，传入显式行号一律放行）。
- `sidecars/tokless_monitor/` & `tools/agy-audit/lib/live-metrics.js`（Fork 增强模块）：Antigravity 官方 Sidecar 实时监控面板（0 模型 Token 底座税），零依赖解码 `conversations/<id>.db` Protobuf 纳秒时间戳与原生 Token 拆分，支持 SQLite WAL 领先步骤实时补齐、`/compact`（`CHECKPOINT`）压缩后秒级重算水位与 `mtimeMs` 后端热重载。
- `targets/`：单文件宿主挂载适配器（`index.js` 注册表、`shared.js` 跨平台拷贝/路径工具、`antigravity.js`、`claude-code.js`、`codex.js`）；其中 `antigravity.js` 额外负责强制拷贝 `sidecars/`、写入绝对 `node` 路径与 Windows `EBUSY` 占用时就地覆写容错（非 `--with-guard` 时清理旧残留 `hooks.json`）。
- `rules/AGENTS.md`、`skills/*`、`agents/*`：分发给终端用户的省流规则模板（含每轮回复末尾 `[📊 Tokless 实时监控](sidecar://agy-tokless/tokless_monitor/)` 原生胶囊入口）、POSIX/PowerShell 双端技能文档与 Antigravity `inheritMcp: false` 净身角色。
- `tools/agy-audit/` & `lib/audit.js`：跨端通用的 `audit project` 常驻规则/MCP 底座账单透视，及 Antigravity 多数据源（`app`/`cli`/`ide`）`list` / `session` / `compare` 会话账单、模型切换缓存断层与压缩节点审计。
- `bin/tokless.js`、`install.js`、`index.js`：统一 CLI（`install` / `uninstall` / `skeleton` / `slice` / `audit`）与 CommonJS `exports`（`.`, `./skeleton`, `./read-guard`, `./audit`）。
- `scripts/bump-version.js`：零依赖版本号同步脚本（`npm run bump -- <x.y.z>` 同步更新 `package.json` 与 `plugin.json`）。
- `docs/` & `benchmarks/`：从主 `README` 抽离的原理说明、API 与扩展开发文档及实测基准报告（不打入 `npm` 安装包）。
- `tests/run-all.js`、`tests/verify-tokless.js` & `tests/**/*.test.js`：核心门禁校验与自动发现的累积回归单元测试套件。

## 3. 核心工程底线（事实不变量）

1. **100% 零外部依赖与 npm v12 天然免疫**：仅使用 Node.js `>=18` 内置模块（可选动态探测如 `node:sqlite` 须在低版本 Node 无缝降级），严禁在 `package.json` 添加第三方 `dependencies`；配合显式 `npx tokless install` 显式安装，天然免疫 npm v12 默认禁用 `postinstall` / git / 远程 tarball 依赖。
2. **未知体量先看骨架再精读**：阅读或修改本仓 `>200` 行代码文件前，先运行 `node ./bin/tokless.js skeleton <path>`（含总行数/总字数与 `--map` 全仓鸟瞰）量化体量并定位 `[L起-L止]` 行号再分段读取，禁止盲读全文或用 `1-800` 泛区间硬扫。
3. **跨平台与无损合并**：钩子须经 `resolveNodeBinary()` 写入 Node 绝对路径（兼容无 `PATH` 的 GUI 宿主）；从 `_npx` 临时目录安装时自动走实体文件拷贝防软链悬空；修改宿主配置（如 `~/.claude/settings.json`）须无损合并，100% 保留用户原有设置与其他 Hooks。
4. **开源纯净度与防反向泄密单测**：严禁在仓库任何受跟踪文件中混入本机用户名、主目录/盘符绝对路径、内部商业标签或私有项目词（`tests/verify-tokless.js` 强校验）。**防隐私扫描单测源码中严禁明文硬编码任何私有项目名、角色名或私人目录名**（防止测试源码随公网提交反向泄密；公开测试仅使用 `os.userInfo().username` 动态探测与通用盘符正则，本地自定义屏蔽词一律存入已 `.gitignore` 忽略的 `.tokless-private-denylist` 按需读取）。
5. **跨端中性品牌、诚实基线与社区共创**：保持跨端中性命名 `tokless`（中文主体 `README.md` + 英文指引 `README.en.md` + 轻量 `assets/logo.svg` 几何矢量标志）；坦诚列明全 Agent 通用能力与特定客户端专属能力，对尚未原生适配的客户端通过开放 `targets/` 单文件插件接口支持社区扩展；引用早期版本实测数据（如 `v0.1.0` 账单对比）必须坦诚注明测试基线版本号，绝不冒充最新版实测结果。
6. **防盲读护栏「递地图而非捆手脚」红线**：`npx tokless install` 默认不挂载 `PreToolUse` 硬拦截钩子（重跑默认安装须自动清理残留旧钩子）；`--with-guard` 可选启用时默认阈值对齐宿主 `800` 行物理上限，且凡显式传入行号或字节偏移参数（`StartLine`/`EndLine`/`offset`/`limit`）一律 100% 放行（避免长对话高缓存水位下打回重读倒贴十万级 Prefix Cache Read）。
7. **版本严格一致**：`package.json` 与 `plugin.json` 的 `version` 必须始终一致，发版统一使用 `npm run bump -- <x.y.z>` 修改，禁止只手改单处或在中英文文档标题中硬编码当前版本号。

## 4. 宿主适配与语言扩展契约

- **新增宿主适配（`targets/<agent>.js`）**：
  - 参考 `targets/claude-code.js` 与 `targets/shared.js`，导出 `{ id, aliases, label, detect(options), install(options), uninstall(options) }`；
  - 统一经 `resolveHomeDir(options)` 获取主目录以支持沙箱测试注入，严禁直接写死 `os.homedir()`；
  - 若宿主支持读前钩子，在 `scripts/read-guard-hook.js` 中扩展载荷解析并保持 `evaluateReadGuard` 纯函数可测；
  - 注册至 `targets/index.js`（`TARGET_ADAPTERS`），并在 `tests/verify-tokless.js` 用隔离 `HOME`/`USERPROFILE` 补齐安装、幂等重装、钩子导航与干净卸载单测。
- **多语言模块化解析（`tools/repo-skeleton/lib/langs/<lang>/`）**：
  - 所有语言解析器统一按 `langs/<lang>/index.js` 平等组织并按后缀惰性加载，单目录收纳同语言多后缀，导出 `{ id, extensions, parse(lines, ext, options) }` 并在 `lib/core/registry.js`（`LANG_DIR_TO_EXTS`）注册；
  - 修复任何真实语法边界问题或新增语言 PR 时，必须在 `tests/langs/<lang>.test.js` 补充复现单测并跑绿全量回归（`tests/run-all.js` 自动递归发现 `tests/**/*.test.js`）。

## 5. 变更联动地图（修改代码后必须同步检查的文件）

| 变更模块 / 动作 | 必须同步检查与更新的文件 |
| :--- | :--- |
| **CLI 子命令或参数变更**（`bin/`、`tools/*/cli.js`） | `bin/tokless.js`、`tools/*/cli.js`（`--help` 文本）→ 对应 `skills/*/SKILL.md`（POSIX + PowerShell 双端命令）→ `rules/AGENTS.md`（若属核心高频命令）→ `README.md` & `README.en.md` 示例 |
| **Programmatic API 导出变更**（`index.js`、`lib/*.js`） | `index.js` + 对应 `lib/*.js` → `docs/contributing-and-api.md` & `docs/contributing-and-api.en.md` → `tests/verify-tokless.js` 导出契约测试 |
| **新增支持语言或文件后缀**（`langs/*`、`registry.js`） | `tools/repo-skeleton/lib/core/registry.js` + `langs/<lang>/index.js` + `tests/langs/<lang>.test.js`（`read-guard-hook.js` 自动派生后缀；若为全新语言大类则同步双语 `README` 与 `docs/contributing-and-api*.md`，不在主 `README` 罗列全部冷门变体后缀） |
| **新增一键挂载宿主**（`targets/<agent>.js`） | `targets/index.js` + `bin/tokless.js` `--target` 帮助 + `tests/verify-tokless.js` 隔离安装/卸载测试 + 双语 `README` 与 `docs/why-tokless*.md`、`docs/contributing-and-api*.md` |
| **修改用户模板**（`rules/AGENTS.md`、`skills/*/SKILL.md`） | 核对 `targets/claude-code.js`（`rewriteClaudeSkillDoc`）与 `targets/codex.js`（`rewriteCodexSkillDoc`）中的路径替换正则是否仍完整匹配；确认双端命令无纯 POSIX 参数展开语法 |
| **发版（Release）** | 运行 `npm run bump -- <x.y.z>` 同步版本 → 更新双语 `README` 致谢名单（如有新贡献者）→ 通过 `npm test` 与 `npm pack --dry-run` |

## 6. 提交与发版门禁

提交 PR 或发版前必须通过全量检查：

```bash
npm run bump -- <x.y.z>   # 仅发版时执行：同步 package.json 与 plugin.json 版本号
npm test                  # 运行门禁自检 + 全部 tests/**/*.test.js 回归单测
npm pack --dry-run        # 核查发布 tarball 文件列表与体积
```

发布 NPM 包前，由于 NPM 短期登录态过期后直接执行 `npm publish` 常会返回误导性的 `404 Not Found`，AI 须先运行只读探针 `npm whoami` 核实当前登录态，再向维护者提供带自动重登预检的发布命令（严禁 AI 擅自执行 `npm publish`；本机私有路径与发包备忘统一维护在已 `.gitignore` 忽略的 `AGENTS.local.md`）：

- POSIX: `(npm whoami || npm login) && npm publish --access public`
- PowerShell: `if (!(npm whoami 2>$null)) { npm login }; npm publish --access public`

## 7. Fork 日常维护速查（同步上游 / 本地重装 / 推送）

本仓库采用单主干模式（`main` 为最新完整版，远端 `origin` 指向官方上游，`fork` 指向个人 Fork）：

1. **同步上游更新**：
   ```bash
   git fetch origin --tags && git merge origin/main
   ```
   合并时须重点保留 4 处 Fork 定制：`sidecars/tokless_monitor/`、`tools/agy-audit/lib/live-metrics.js`、`targets/antigravity.js`（`sidecars` 挂载 + Windows `EBUSY` 覆写容错 + 清理残留 `hooks.json`）及 `rules/AGENTS.md` 末尾每轮 `sidecar://` 胶囊规则；并同步核对 `package.json` 的 `"sidecars/"` 与 `live-metrics.js` 对 `paths.js` 的调用签名。
2. **验证与本机生效**：
   ```bash
   npm test && node install.js --target agy --copy
   ```
   - 仅改动 `sidecars/tokless_monitor/index.html` 或 `tools/agy-audit/lib/live-metrics.js` 时支持热重载（重开监控面板即可生效）；
   - 改动 `sidecar.json` 或 `main.mjs` 时需重启客户端或在插件管理中重开关一次 `agy-tokless`；
   - 改动 `rules/AGENTS.md` 下一轮/新会话自动生效。
3. **推送发布**：
   ```bash
   git push fork main
   ```
