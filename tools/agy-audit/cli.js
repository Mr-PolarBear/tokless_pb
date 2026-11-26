#!/usr/bin/env node
'use strict';

const { listSessions } = require('./lib/paths');
const { analyzeSession } = require('./lib/analyzer');
const { compareSessions } = require('./lib/compare');
const { auditProject } = require('./lib/project');
const {
  formatSessionMarkdown,
  formatSessionListMarkdown,
  formatCompareMarkdown,
  formatProjectMarkdown,
} = require('./lib/formatter');

const BOOLEAN_FLAGS = new Set(['json', 'help', 'h']);
const VALUE_FLAGS = new Set(['source', 'limit', 'data-dir', 'dir', 'home']);

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        flags[key] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
        } else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          flags[key] = argv[i + 1];
          i++;
        } else if (!BOOLEAN_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags[key] = argv[i + 1];
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  return { flags, positionals };
}

function printHelp() {
  console.log(`
Antigravity 本地账单体检与前后对比工具 (agy-audit CLI · 0 Token 运行)

使用说明:
  node cli.js list [--source all|cli|app|ide] [--limit <N>] [--data-dir <path>] [--json]
    列出本地最近的 Antigravity 会话（自动检索 ~/.gemini/antigravity、antigravity-cli、antigravity-ide）。

  node cli.js session [id-or-prefix-or-path | latest | latest~N] [--source all|cli|app|ide] [--data-dir <path>] [--json]
    解剖单个 Antigravity 会话日志（省略参数默认 latest），统计最慢步骤 Top 3、read_file 盲读与按行读取统计、外部 MCP 空载、Prefix Cache 命中率/断层告警、上下文水位与 Top 5 烧钱步骤。

  node cli.js compare <id_or_path_before> <id_or_path_after> [--source all|cli|app|ide] [--data-dir <path>] [--json]
    对比两个会话的量化指标、缓存命中率与节省比例 (%)，支持 latest~1 latest。

  node cli.js project <dirPath> [--json]
    检查目标项目的常驻规则（.agents/.agent/_agents/_agent）与 Skill 肥胖度，并估算全局/工作区 MCP 与工具底座空载税。

示例:
  node tools/agy-audit/cli.js list --source cli
  node tools/agy-audit/cli.js session latest
  node tools/agy-audit/cli.js session 3e4efc2c --json
  node tools/agy-audit/cli.js compare latest~1 latest
  node tools/agy-audit/cli.js project ./my-project
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    return;
  }

  const { flags, positionals } = parseArgs(argv);
  if (flags.help || flags.h) {
    printHelp();
    return;
  }

  const cmd = (positionals[0] || '').toLowerCase();
  const commonOptions = {};
  if (typeof flags.source === 'string' && flags.source.trim()) {
    commonOptions.source = flags.source.trim();
  }
  const dataDir = flags['data-dir'] || flags.dir;
  if (typeof dataDir === 'string' && dataDir.trim()) {
    commonOptions.dataDir = dataDir.trim();
  }
  if (typeof flags.home === 'string' && flags.home.trim()) {
    commonOptions.homeDir = flags.home.trim();
  }

  try {
    if (cmd === 'list') {
      const limit = flags.limit !== undefined ? parseInt(flags.limit, 10) : 10;
      const sessions = listSessions({
        ...commonOptions,
        limit: Number.isInteger(limit) && limit >= 0 ? limit : 10,
      });
      if (flags.json) {
        console.log(
          JSON.stringify(
            { source: commonOptions.source || 'all', count: sessions.length, sessions },
            null,
            2
          )
        );
      } else {
        console.log(formatSessionListMarkdown(sessions, commonOptions));
      }
    } else if (cmd === 'session') {
      const id = positionals[1] || 'latest';
      const report = analyzeSession(id, commonOptions);
      if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatSessionMarkdown(report));
      }
    } else if (cmd === 'compare') {
      const idBefore = positionals[1];
      const idAfter = positionals[2];
      if (!idBefore || !idAfter) {
        console.error('❌ 请提供两个会话 ID 进行对比，例如: node cli.js compare latest~1 latest');
        process.exit(1);
      }
      const cmp = compareSessions(idBefore, idAfter, commonOptions);
      if (flags.json) {
        console.log(JSON.stringify(cmp, null, 2));
      } else {
        console.log(formatCompareMarkdown(cmp));
      }
    } else if (cmd === 'project') {
      const dirPath = positionals[1];
      if (!dirPath) {
        console.error('❌ 请提供单个目标项目路径，例如: node cli.js project ./my-project');
        process.exit(1);
      }
      const options = flags.home ? { homeDir: flags.home } : {};
      const report = auditProject(dirPath, options);
      if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatProjectMarkdown(report));
      }
    } else {
      console.error(`❌ 未知子命令 "${cmd}"。支持: list, session, compare, project`);
      printHelp();
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ 执行失败: ${err.message}`);
    process.exit(1);
  }
}

main();
