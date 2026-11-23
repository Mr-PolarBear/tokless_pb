# AI 编程省流读取、净身角色与缓存保护规范 (tokless)

## 1. 先看代码骨架，再按行号精准读取 (`tokless skeleton` / `repo-skeleton`)
- **严禁盲目全量读取大代码文件**：在未确定目标函数、类或逻辑块所在行号前，严禁不带起止行号（`StartLine`/`EndLine` 或 `offset`/`limit`）直接读取超过 200 行的源码文件，也严禁传入 `1~全文末尾` 的假切片糊弄全读。
- **两步精准定位法**：
  1. 探索陌生目录或大文件时，先用 `tokless skeleton`（兼容 `repo-skeleton`）提取语法签名与 `[L起-L止]` 行号（0 模型 Token，比盲读全文省 85%~97% 探索开销）：
     - 全局 CLI（推荐）: `tokless skeleton <目录或文件路径> --depth 2`
     - macOS / Linux: `node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <目录或文件路径> --depth 2`
     - Windows (PowerShell): `node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <目录或文件路径> --depth 2`
  2. 根据骨架中的 `[L起-L止]` 行号，调用 `read_file(Path, StartLine, EndLine)`（或 `Read(file_path, offset, limit)`）按需完整读取目标函数或逻辑块（无单次行数跨度硬限制，只要有明确目标区间即可一次读完）。

## 2. 轻量角色净身（卸除无关 MCP 与工具底座税）
- 纯代码编写或只读代码审查会话优先启用 `inheritMcp: false` 及最小 `tools` 清单（如内置净身角色 `tokless-coder`、`tokless-reviewer`），剥离用不上的浏览器/外部 MCP Schema 每步固定底座税。

## 3. 本地账单透视、Prefix Cache 保护与控水位减轮次 (`tokless audit` / `agy-audit`)
- **0 Token 账单与底座税体检**（支持 `session <ID>` 查缓存断层与 Top 5 膨胀步、`compare <前ID> <后ID>`、`project <项目目录>` 查规则肥胖度与 MCP 空载税）：
  - 全局 CLI（推荐）: `tokless audit <session|compare|project> <参数>`
  - macOS / Linux: `node "$HOME/.gemini/config/plugins/agy-tokless/tools/agy-audit/cli.js" <session|compare|project> <参数>`
  - Windows (PowerShell): `node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\agy-audit\cli.js" <session|compare|project> <参数>`
- **严控终端输出与保护 Prefix Cache**：`run_command` 必须主动限制长日志输出规模；对话中途保持顶部规则稳定只追加，控制上下文水位与对话轮次以降低累计 `Cache Read` 滚雪球并避免触发历史自动压缩（三代模型常见约 256K，四代模型实测跑上 440K 未触发、推测约 512K）。
- **一键会话实时监控入口**：每次新会话的首次回复末尾，附带一行原生胶囊链接 `[📊 Tokless 实时监控](sidecar://agy-tokless/tokless_monitor/)`，方便用户一键打开右侧实时 Token/TTFT/缓存率监控面板（后续轮次无需重复刷屏）。
