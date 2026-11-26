---
name: code-skeleton
description: 提取代码文件或目录的紧凑语法骨架（仅保留类名、函数签名、导出接口与精确 [L起-L止] 行号，剥离具体实现代码），或按函数/类方法/章节名精准切片源码（抗并发改动行号漂移）。支持 C/C++ 大头文件与源码（.c/.h/.cpp/.hpp 的宏、typedef、struct、extern "C" 与条件编译平衡）。在探索代码库、排查 Bug 或读取中大型文件前使用此技能快速定位行号或符号，可减少 85%~97% 的探索期 Token 消耗。
---

# 代码骨架极速提取与按符号切片指南 (code-skeleton)

为了避免调用 `read_file` 或 `Read` 盲目全量读取几百行代码导致后续每一轮对话背负高额的 Cache Read 滚雪球成本，请先提取带 `[L起-L止]` 行号的语法骨架，或直接按符号名精确切片目标源码。

## 使用方法

> 注：若已全局安装 `tokless` 包，可直接运行 `tokless skeleton <路径> [--depth 2]`（兼容 `repo-skeleton`）或 `tokless slice <文件>#<符号> [--line-numbers]`（按函数/类方法/Markdown 章节名实时定位切片，抗并发编辑行号漂移；未命中时自动返回相近候选与全文件符号目录）。Antigravity 仅向 Hook / MCP 进程注入 `PLUGIN_ROOT`，不会注入到常规 `run_command` 终端中，未全局安装 CLI 时请直接使用下方插件路径：

### macOS / Linux (bash / zsh)

```bash
# 1. 扫描源码目录（自动排除 node_modules/.git/dist/target 等，默认深度 2），一步拿到全局函数与行号地图
node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <目录路径> --depth 2

# 2. 提取单个大文件（含 C/C++ .c/.h/.cpp/.hpp）的函数/类/typedef/宏签名与起止行号
node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <文件路径>

# 3. 按符号名精确切片目标函数/类方法/章节源码（抗行号漂移；未命中自动返回候选建议与全文件骨架）
node "$HOME/.gemini/config/plugins/agy-tokless/tools/repo-skeleton/cli.js" <文件路径> --symbol "<Class.method 或章节标题>" --line-numbers
```

### Windows (PowerShell)

```powershell
# 1. 扫描源码目录（自动排除 node_modules/.git/dist/target/Objects/cmake-build-* 等，默认深度 2；支持 --exclude 指定额外忽略目录）
node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <目录路径> --depth 2

# 2. 提取单个大文件（含 C/C++ .c/.h/.cpp/.hpp）的函数/类/typedef/宏签名与起止行号
node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <文件路径>

# 3. 按符号名精确切片目标函数/类方法/章节源码（抗行号漂移；未命中自动返回候选建议与全文件骨架）
node "$env:USERPROFILE\.gemini\config\plugins\agy-tokless\tools\repo-skeleton\cli.js" <文件路径> --symbol "<Class.method 或章节标题>" --line-numbers
```

拿到目标函数的 `[L起-L止]` 行号后，直接调用 `read_file(Path, StartLine, EndLine)`（或 Claude Code `Read(file_path, offset, limit)`）按需完整读取对应代码段；若已知函数/类方法/章节名，也可直接用 `tokless slice <文件>#<符号>`（或 `--symbol`）一步切出源码（针对骨架已定位的目标区间无单次跨度硬限制；但探索陌生中大型文件（`>200` 行）前必须先跑骨架，严禁直接传 `1-800` 等泛大跨度区间批量硬读代替骨架导航；若启用 `--with-guard` 护栏，仅对 `>800` 行无行号盲读返回全文骨架辅助导航）。
