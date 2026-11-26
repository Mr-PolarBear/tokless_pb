# 为什么需要 Tokless？核心原理与各工具挂载说明

[返回主文档 (README.md)](../README.md) | [English](./why-tokless.en.md)

---

## 一、有了 IDE 自带的 `@Codebase` 或 `repomix`，为什么周额度还是掉得飞快？

通过对数十份底层会话账单日志（`transcript_full.jsonl`）的逐帧解剖，吃光额度的元凶非常清晰：

### 1. `@Codebase` 是找线索的「搜索引擎」，`tokless` 是防偷懒的「省流刹车系统」

| 工具类型 | 代表工具 | 核心职责 | 为什么单靠它省不了 Agent 循环里的额度？ |
| :--- | :--- | :--- | :--- |
| **语义搜索引擎** | IDE 自带 `@Codebase` | 向量/关键词检索，帮 AI 找到“大概在哪个文件” | **只管找路，不管怎么读**。AI 拿到文件名后，下一步依然习惯性无行号盲读（或传 `1-800` 泛区间硬读），顺手把整份一两千行源码塞进上下文。 |
| **全仓打包器** | `repomix` / `gitingest` | 把整个仓库压成单文件喂给网页聊天框 | 适合无本地工具权限的网页问答；若塞进本地多轮 Agent 会话，相当于第 1 步直接背上几万 Token 包袱。 |
| **语法骨架与账单透视** | **`tokless`** | **毫秒级零索引出 `[L起-L止]` 骨架 + 可选盲读护栏 + 本地账单体检** | 先用 0 模型 Token 语法骨架定位 `[L起-L止]` 行号再按需切片精读；配合净身角色剥离无关 MCP 底座税，并用本地账单工具透视真实开销。 |

`tokless` 与 `@Codebase` 天然互补：`@Codebase` 负责回答“去哪几个文件找”，`tokless` 负责在读取那一刻只让真正要改的那几十行代码进入上下文。

### 2. 「Cache Read 滚雪球效应」与上下文自动压缩水位

在多步 Agent 循环中，真正烧光额度的往往不是单次 `Input`，而是每一步反复重读历史上下文的 **`Cache Read`**：

$$\text{累计 Cache Read} \approx \text{平均上下文水位} \times \text{模型调用轮数}$$

- **早一步塞进废话，步步交复利税**：如果第 3 步盲读塞进 3 万 Token 无关代码，整个任务跑了 50 轮，这 3 万 Token 就会在后续每一步被重复计费 47 次，单这一步就白烧 **140 万+ Cache Read Token**。
- **跨模型切换断层（Cache Cliff）**：模型的 Prefix Cache 与具体模型权重绑定。如果在同一长会话中途来回切换模型（含双模型调度器自动往返），历史上下文缓存会失效并按原价 `Input` 重新计费（可通过 `tokless audit session latest` 直接检测归因）。
- **远离隐式压缩失忆线**：三代模型常见在约 **256K** 水位触发强制摘要压缩（`CHECKPOINT: # Resuming from a compaction`，导致细节丢失与反复重读）；四代模型实测跑上 440K 未触发压缩（社区推测约 **512K**）。无论上限在哪，**压低每步水位 + 减少探索轮数**都是同时保住代码记忆精度与周额度的核心解法。

---

## 二、各工具安装位置与日常接入方式

### 1. 已内置一键挂载的三大工具（`npx tokless install`）

- **Google Antigravity**（`--target agy`）：
  - **安装位置**：`~/.gemini/config/plugins/agy-tokless/`（挂载 `plugin.json`、`rules/AGENTS.md`、`skills/`、`agents/`；加 `--with-guard` 时额外生成 `hooks.json`）。
  - **日常使用**：新开对话自动生效——探索大文件时触发 `code-skeleton` 按行号精读；纯写码或只读审查可直接使用 `tokless-coder` / `tokless-reviewer`（CLI 支持 `agy --agent tokless-coder`）剥离外部 MCP 税；查账单时运行 `npx tokless audit session latest`。
- **Claude Code**（`--target claude`）：
  - **安装位置**：核心脚本存入 `~/.claude/tokless/`，技能写入 `~/.claude/skills/code-skeleton/SKILL.md`；加 `--with-guard` 时将 `Read` 盲读导航钩子无损合并进 `~/.claude/settings.json`（重跑默认安装会自动剥离旧钩子并保留原有配置）。
  - **日常使用**：启动 `claude` 后自动发现 `code-skeleton` 技能；开启 `--with-guard` 后，不带 `offset/limit` 盲读超过 800 行的代码文件会自动收到 `[L起-L止]` 骨架引导。
- **Codex CLI**（`--target codex`）：
  - **安装位置**：`~/.codex/skills/code-skeleton/`（含 `SKILL.md` 与零依赖 `tools/repo-skeleton` 脚本）。
  - **日常使用**：自动发现 `code-skeleton` 技能；建议同时将 [`rules/AGENTS.md`](../rules/AGENTS.md) 合入项目根 `AGENTS.md` 强化主动触发。

### 2. 其他 AI 编程工具（Cursor、Windsurf、Cline、Roo Code、Trae、OpenCode 等）

1. 全局安装 CLI：`npm i -g tokless`（获得全局 `tokless skeleton` 与 `tokless audit project` 命令）；
2. 将 [`rules/AGENTS.md`](../rules/AGENTS.md) 中的省流读取规范复制到项目根目录 `AGENTS.md`（或 `.cursor/rules/`、`.windsurfrules`、`.clinerules` 等规则文件）即可立即生效。
3. 如果你希望为常用编辑器补齐官方 `npx tokless install` 一键挂载，欢迎参考 [扩展开发与 API 指南](./contributing-and-api.md) 提交适配器 PR。
