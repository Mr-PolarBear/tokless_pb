# AI 编程省流读取、净身角色与缓存保护规范 (tokless)

## 1. 先看代码骨架或按符号切片，再精准读取 (`tokless skeleton` / `tokless slice` / `repo-skeleton`)
- **拒绝无行号盲读与“伪精准”大区间硬读**：探索陌生模块或中大型代码文件（约 `>200` 行）前必须先提取语法骨架定位行号，或直接按符号名切片；严禁不抽骨架直接无行号盲读，或用 `StartLine=1, EndLine=800` 等泛大跨度区间伪装按行读取来跳过骨架导航（可选启用 `--with-guard` 读前护栏后，仅对 `>800` 行无行号盲读自动返回全文骨架辅助导航，凡传入显式行号参数一律放行）。
- **两步精准定位与按符号抗漂移切片**：
  1. 探索陌生目录或大文件时，先用 `tokless skeleton`（兼容 `repo-skeleton`）提取语法签名与 `[L起-L止]` 行号（0 模型 Token，比盲读全文省 85%~97% 探索开销）：
     - 全局 CLI（推荐）: `tokless skeleton <目录或文件路径> --depth 2`
     - macOS / Linux: `node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <目录或文件路径> --depth 2`
     - Windows (PowerShell): `node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <目录或文件路径> --depth 2`
  2. 根据骨架中的 `[L起-L止]` 行号，调用 `read_file(Path, StartLine, EndLine)`（或 `Read(file_path, offset, limit)`）按需完整读取目标函数或逻辑块（针对骨架已定位的明确目标区间无单次跨度硬限制，可一次读完；未定位前禁止用 `1-800` 等满额区间批量扫读多个陌生文件）；若已知函数/类方法/Markdown 章节名，也可直接用 `tokless slice <文件>#<符号>`（或 `cli.js <文件> --symbol <符号> [--line-numbers]`）实时定位切出源码，天然抵抗并发编辑引起的行号漂移，未命中时自动返回相近候选与全文件符号目录。

## 2. 轻量角色净身（卸除无关 MCP 与工具底座税）
- 纯代码编写或只读代码审查会话优先启用 `inheritMcp: false` 及最小 `tools` 清单（如内置净身角色 `tokless-coder`、`tokless-reviewer`），剥离用不上的浏览器/外部 MCP Schema 每步固定底座税。

## 3. 本地账单透视、Prefix Cache 保护与控水位减轮次 (`tokless audit` / `agy-audit`)
- **0 Token 账单与底座税体检**（支持 `list` 列最近会话、`session <ID|latest>` 查缓存断层/模型切换归因与 Top 5 膨胀步、`compare <前ID> <后ID>`、`project <项目目录>` 查常驻规则与 MCP 底座账单）：
  - 全局 CLI（推荐）: `tokless audit <list|session|compare|project> <参数>`
  - macOS / Linux: `node "$HOME/.gemini/config/plugins/agy-tokless/tools/agy-audit/cli.js" <list|session|compare|project> <参数>`
  - Windows (PowerShell): `node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\agy-audit\cli.js" <list|session|compare|project> <参数>`
- **严控终端输出与保护 Prefix Cache**：`run_command` 必须主动限制长日志输出规模；对话中途保持顶部规则稳定只追加，控制上下文水位与对话轮次以降低累计 `Cache Read` 滚雪球并避免触发历史自动压缩（三代模型常见约 256K，四代模型实测跑上 440K 未触发、推测约 512K）。
- **一键会话实时监控入口**：每次对用户的最终回复末尾（子代理内部汇报除外），固定附带一行原生胶囊链接 `[📊 Tokless 实时监控](sidecar://agy-tokless/tokless_monitor/)`，确保无论对话进行到第几轮，最新回复正下方始终可一键展开/收起右侧实时监控面板。
