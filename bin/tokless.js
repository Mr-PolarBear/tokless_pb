#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');
const { parseCliArgs, runInstall, runUninstall } = require('../install');
const { parseSliceTarget, sliceSymbol } = require('../lib/slice');

const REPO_ROOT = path.resolve(__dirname, '..');

function printHelp() {
  console.log(`tokless v${pkg.version} - AST codebase skeletonizer, symbol slicer, optional blind-read guard & session token auditor

Usage:
  tokless install [--target agy|claude|codex|all] [--with-guard] [--copy]
  tokless uninstall [--target agy|claude|codex|all]
  tokless skeleton <file-or-dir> [--depth <N>] [--exclude <dirs>] [--symbol <query>] [--line-numbers] [--map] [--json]
  tokless slice <file#symbol | file> [symbol] [--line-numbers] [--json]
  tokless audit <list|session|compare|project> [args...] [--json]
  tokless --version | -v
  tokless --help | -h

Install Options:
  --with-guard   Opt-in PreToolUse hook (>800-line unsliced blind-read skeleton navigator; disabled by default)
  --copy         Copy files instead of linking (auto-enabled in _npx / node_modules)

Targets:
  agy      Antigravity (~/.gemini/config/plugins/agy-tokless)
  claude   Claude Code (~/.claude/tokless + skills; optional settings.json PreToolUse Read hook via --with-guard)
  codex    Codex CLI (~/.codex/skills/code-skeleton)
  all      Install/uninstall across all supported targets
  (omit)   Auto-install Antigravity + any detected ~/.claude or ~/.codex host`);
}

function printSliceHelp() {
  console.log(`tokless slice - Extract exact function/class/method/section source code by symbol name

Usage:
  tokless slice <file>#<symbol> [--line-numbers] [--json]
  tokless slice <file> <symbol> [--line-numbers] [--json]

Options:
  --line-numbers, -n   Prefix each sliced source line with its 1-based line number
  --json               Output structured JSON result
  -h, --help           Show this help message

Examples:
  tokless slice src/server.js#Server.start
  tokless slice src/parser.cpp Foo::bar --line-numbers
  tokless slice README.md "Quick Start"`);
}

function runSliceSubcommand(args) {
  let help = false;
  let json = false;
  let lineNumbers = false;
  const positionals = [];
  let explicitSymbol = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--line-numbers' || arg === '-n') {
      lineNumbers = true;
    } else if (arg === '--symbol' || arg === '-s') {
      if (args[i + 1] !== undefined) {
        explicitSymbol = args[i + 1];
        i++;
      }
    } else if (arg.startsWith('--symbol=')) {
      explicitSymbol = arg.slice('--symbol='.length);
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  if (help || positionals.length === 0) {
    printSliceHelp();
    process.exit(help ? 0 : 1);
  }

  const targetArg = positionals[0];
  const secondArg = explicitSymbol !== null ? explicitSymbol : positionals[1];
  const parsed = parseSliceTarget(targetArg, secondArg);

  if (!parsed.filePath || !parsed.symbol) {
    console.error(
      '[tokless] Missing symbol query. Usage: tokless slice <file#symbol> or tokless slice <file> <symbol>'
    );
    process.exit(1);
  }

  try {
    const res = sliceSymbol(parsed.filePath, parsed.symbol, { lineNumbers });
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(res.formatted);
    }
    if (!res.found) {
      process.exit(2);
    }
  } catch (err) {
    console.error(`[tokless] ${err.message}`);
    process.exit(1);
  }
}

function forwardSubtool(relScriptPath, subArgs) {
  const scriptPath = path.join(REPO_ROOT, relScriptPath);
  const res = spawnSync(process.execPath, [scriptPath, ...subArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status !== null ? res.status : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return;
  }

  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(pkg.version);
    return;
  }

  const subcmd = argv[0];
  const rest = argv.slice(1);

  if (subcmd === 'install') {
    const parsed = parseCliArgs(rest);
    if (parsed.help) {
      printHelp();
      return;
    }
    try {
      runInstall({
        sourceDir: REPO_ROOT,
        target: parsed.target,
        copy: parsed.copy,
        withGuard: parsed.withGuard,
        mode: 'auto',
      });
    } catch (err) {
      console.error(`[tokless] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcmd === 'uninstall') {
    const parsed = parseCliArgs(rest);
    if (parsed.help) {
      printHelp();
      return;
    }
    try {
      runUninstall({
        target: parsed.target || 'all',
        mode: 'auto',
      });
    } catch (err) {
      console.error(`[tokless] ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (subcmd === 'skeleton' || subcmd === 'skel') {
    forwardSubtool('tools/repo-skeleton/cli.js', rest);
    return;
  }

  if (subcmd === 'slice') {
    runSliceSubcommand(rest);
    return;
  }

  if (subcmd === 'audit') {
    forwardSubtool('tools/agy-audit/cli.js', rest);
    return;
  }

  console.error(`[tokless] Unknown command: "${subcmd}". Run "tokless --help" for usage.`);
  process.exit(1);
}

main();
