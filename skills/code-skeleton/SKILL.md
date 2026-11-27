---
name: code-skeleton
description: 提取代码文件或目录的紧凑语法骨架（含类名、函数/宏/typedef/struct 签名与精确 [L起-L止] 行号），或按函数/类方法/章节名在单文件及跨目录精准切片源码（改后防行号漂移、抗并发编辑与跨文件查符号）。支持 JS/TS、Python、Go、Rust、Java、C/C++(.c/.h/.cpp/.hpp) 等多语言，探索排错前使用可省 85%~97% Token。
---

# 代码骨架极速提取与按符号切片指南 (code-skeleton)

读取陌生或中大型文件（`>200` 行）前，先提取 `[L起-L止]` 语法骨架或按符号精准切片，避免整份盲读持续推高每轮 `Cache Read`。

## 何时直接用 `tokless slice`

- **刚改过中大型文件再看或改附近函数**：行号已挪动，别靠脑补加减行号或放大区间硬扫，直接 `tokless slice <文件>#<符号> -n` 一步切出最新源码与准确行号。
- **多人或多代理并发改同一文件**：直接按符号切片，彻底免疫行号漂移。
- **只记符号名、不确定在哪个文件**：直接传目录 `tokless slice <目录>#<符号> -n` 跨文件定位切出源码（自动遵守 `.gitignore` 与常见噪音排除，显式指向被忽略目录如 `node_modules/<pkg>` 时自动放行；多处同名命中自动切导航清单，加 `--all` 展开全部）。

## 使用方法

全局安装 `tokless` 后直接运行（未命中自动返回候选建议）：

```bash
tokless skeleton <目录或文件路径> [--depth 2] [--exclude <dirs>]   # 签名与 [L起-L止] 地图（--map 鸟瞰全仓）
tokless slice <文件或目录>#<符号> -n [--all] [--depth <N>]           # 单文件或跨目录按符号切片（-n 附行号）
```

未全局安装 CLI 时使用插件绝对路径（Antigravity 不会向常规终端注入 `PLUGIN_ROOT`）：

### macOS / Linux (bash / zsh)

```bash
node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <目录或文件> [--depth 2]
node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <文件或目录> --symbol "<Class.method 或章节标题>" --line-numbers
```

### Windows (PowerShell)

```powershell
node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <目录或文件> [--depth 2]
node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <文件或目录> --symbol "<Class.method 或章节标题>" --line-numbers
```

拿到 `[L起-L止]` 后调 `read_file(Path, StartLine, EndLine)`（或 `Read(file_path, offset, limit)`）按需精读目标区间（已定位区间无单次跨度硬限制；未定位前禁传 `1-800` 等泛区间硬扫；可选 `--with-guard` 仅对 `>800` 行无行号盲读返回骨架）。
