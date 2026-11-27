#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  generateFileSkeleton,
  scanDirectorySkeleton,
  formatDirectorySkeleton,
  formatDirectoryMap,
  generateRepoMap,
  parseSliceTarget,
  sliceSymbol,
} = require('./lib/skeleton');

function printUsage() {
  console.log(`repo-skeleton - 极速提取代码文件或目录的紧凑语法骨架、精确行号范围与跨目录符号切片

用法:
  node cli.js <文件路径> [--symbol <符号或章节名>] [--line-numbers] [--map] [--json]
  node cli.js <目录路径> [--symbol <符号或章节名>] [--line-numbers] [--all] [--depth <深度>] [--exclude <dir1,dir2>] [--map] [--json]

选项:
  --depth <N>        目录扫描最大深度（常规默认: 2，--map 默认: 8，--symbol 目录模式默认不限深度；自动遵守 .gitignore 并排除 node_modules/.git/dist/build/exports/.next/.nuxt/target/__pycache__/.venv/venv/coverage/.turbo/Objects/Listings/.cache/.clangd/cmake-build-*）
  --exclude <dirs>   额外排除的目录名或相对路径（逗号分隔，可重复传入）
  --symbol <query>   按符号/方法/章节名精确提取单文件或跨目录源码切片（支持 Class.method、Type::fn、Parent > Child，未命中自动返回候选建议）
  --line-numbers     切片输出时每行附带源码行号（配合 --symbol 使用）
  --all              跨目录 --symbol 多处命中时强制展开全部源码切片（默认 >3 处或 >200 行自动切换为全量导航清单）
  --map              极简全仓文件体量地图模式（仅输出相对路径、总行数与总字数，不展开函数签名）
  --json             输出结构化 JSON
  -h, --help         显示帮助信息`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let target = null;
  let symbol = null;
  let lineNumbers = false;
  let all = false;
  let depth = null;
  let map = false;
  let json = false;
  let help = false;
  const exclude = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--map') {
      map = true;
    } else if (arg === '--line-numbers' || arg === '-n') {
      lineNumbers = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--symbol' || arg === '-s') {
      const next = args[i + 1];
      if (next !== undefined) {
        symbol = next;
        i++;
      }
    } else if (arg.startsWith('--symbol=')) {
      symbol = arg.slice('--symbol='.length);
    } else if (arg === '--depth') {
      const next = args[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        depth = parseInt(next, 10);
        i++;
      }
    } else if (arg.startsWith('--depth=')) {
      const val = arg.slice('--depth='.length);
      if (/^\d+$/.test(val)) {
        depth = parseInt(val, 10);
      }
    } else if (arg === '--exclude') {
      const next = args[i + 1];
      if (next !== undefined) {
        for (const p of next.split(',')) {
          if (p.trim()) exclude.push(p.trim());
        }
        i++;
      }
    } else if (arg.startsWith('--exclude=')) {
      const val = arg.slice('--exclude='.length);
      for (const p of val.split(',')) {
        if (p.trim()) exclude.push(p.trim());
      }
    } else if (!arg.startsWith('-') && !target) {
      target = arg;
    }
  }

  const effectiveDepth = depth !== null ? depth : (map ? 8 : 2);
  return {
    target,
    symbol,
    lineNumbers,
    all,
    depth: effectiveDepth,
    explicitDepth: depth,
    map,
    json,
    help,
    exclude,
  };
}

function main() {
  const { target, symbol, lineNumbers, all, depth, explicitDepth, map, json, help, exclude } =
    parseArgs(process.argv);

  if (help || !target) {
    printUsage();
    process.exit(help ? 0 : 1);
  }

  const parsedTarget = parseSliceTarget(target, symbol);
  const hasSymbolRequest = Boolean(
    (symbol !== null && String(symbol).trim() !== '') ||
      (parsedTarget.rawSymbol && !fs.existsSync(path.resolve(target)))
  );
  const resolved = path.resolve(hasSymbolRequest ? parsedTarget.filePath : target);
  if (!fs.existsSync(resolved)) {
    console.error(`错误: 目标路径不存在: ${resolved}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolved);
  const t0 = performance.now();

  if (hasSymbolRequest) {
    if (!stat.isFile() && !stat.isDirectory()) {
      console.error(`错误: 不支持的目标类型: ${resolved}`);
      process.exit(1);
    }
    const sliceOpts = {
      lineNumbers,
      all,
      exclude,
    };
    if (explicitDepth !== null) {
      sliceOpts.depth = explicitDepth;
    }
    const sliceRes = sliceSymbol(resolved, parsedTarget.symbol, sliceOpts);
    if (json) {
      console.log(JSON.stringify(sliceRes, null, 2));
    } else {
      console.log(sliceRes.formatted);
    }
    if (!sliceRes.found) {
      process.exit(2);
    }
    return;
  }

  if (map) {
    const result = generateRepoMap(resolved, { depth, exclude });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.text);
    return;
  }

  if (stat.isFile()) {
    const result = generateFileSkeleton(resolved, { includeHeader: false });
    const elapsedMs = Number((performance.now() - t0).toFixed(2));

    if (json) {
      console.log(JSON.stringify({ mode: 'file', elapsedMs, ...result }, null, 2));
      return;
    }

    const charCount = result.charCount ?? result.rawChars ?? 0;
    console.log(`文件: ${result.filePath}`);
    console.log(
      `统计: 总行数 ${result.totalLines} 行 · ${charCount.toLocaleString('en-US')} 字 | 全文估算 ${result.rawTokens} tokens → 骨架估算 ${result.skeletonTokens} tokens (节省 ${result.savedPercent}%, 耗时 ${elapsedMs}ms)`
    );
    console.log('---');
    console.log(result.formatted);
    return;
  }

  if (stat.isDirectory()) {
    const result = scanDirectorySkeleton(resolved, { depth, exclude });
    const elapsedMs = Number((performance.now() - t0).toFixed(2));

    if (json) {
      console.log(JSON.stringify({ mode: 'directory', elapsedMs, ...result }, null, 2));
      return;
    }

    console.log(formatDirectorySkeleton(result, { elapsedMs }));
    return;
  }

  console.error(`错误: 不支持的目标类型: ${resolved}`);
  process.exit(1);
}

main();
