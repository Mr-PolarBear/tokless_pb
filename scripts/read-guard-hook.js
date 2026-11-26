#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { SUPPORTED_EXTS } = require('../tools/repo-skeleton/lib/core/registry');

const READ_GUARD_SCRIPT_PATH = __filename;
const HOOKS_CONFIG_PATH = path.resolve(__dirname, '../hooks.json');
const PLUGIN_MANIFEST_PATH = path.resolve(__dirname, '../plugin.json');
const MAX_SKELETON_ITEMS = 120;
const MAX_FALLBACK_SEGMENTS = 20;

const GUARDED_CODE_EXTS = new Set(
  [...SUPPORTED_EXTS].filter((ext) => ext !== '.md' && ext !== '.mdx')
);

function loadSkeletonGenerator() {
  const localLib = path.resolve(__dirname, '../tools/repo-skeleton/lib/skeleton.js');
  return require(localLib).generateFileSkeleton;
}

function getMaxLinesThreshold(overrideVal) {
  if (overrideVal !== undefined && overrideVal !== null) {
    const parsedOverride = parseInt(String(overrideVal), 10);
    if (Number.isInteger(parsedOverride) && parsedOverride > 0) {
      return parsedOverride;
    }
  }
  const raw = process.env.TOKLESS_READ_MAX_LINES || process.env.AGY_READ_MAX_LINES;
  if (!raw) return 800;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 800;
}

function parseLineArg(val) {
  if (val === undefined || val === null || val === '') return null;
  const parsed = Number(val);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function buildFallbackSegments(filePath, totalLines, maxLines) {
  let lines = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  } catch (_) {
    return `(未识别到显式函数/类签名，全文件共 ${totalLines} 行)`;
  }

  const step = Math.max(200, Math.min(maxLines, 400));
  const out = [`(未识别到显式函数/类签名，按每段 ${step} 行提供首行定位预览：)`];
  let segmentCount = 0;
  for (let start = 1; start <= totalLines; start += step) {
    if (segmentCount >= MAX_FALLBACK_SEGMENTS) {
      out.push(`... (后段 [L${start}-L${totalLines}] 省略，请按区间继续分段读取)`);
      break;
    }
    const end = Math.min(totalLines, start + step - 1);
    let preview = '(空行/注释)';
    for (let idx = start - 1; idx < end && idx < lines.length; idx++) {
      const t = lines[idx].trim();
      if (t) {
        preview = t.length > 60 ? t.slice(0, 57) + '...' : t;
        break;
      }
    }
    out.push(`[L${start}-L${end}] ${preview}`);
    segmentCount++;
  }
  return out.join('\n');
}

function formatBoundedSkeleton(skeleton, filePath, maxLines) {
  if (!skeleton.items || skeleton.items.length === 0) {
    return buildFallbackSegments(filePath, skeleton.totalLines, maxLines);
  }
  if (skeleton.items.length <= MAX_SKELETON_ITEMS) {
    return skeleton.formatted;
  }
  const headLines = skeleton.items.slice(0, MAX_SKELETON_ITEMS).map((item) => {
    const indent = '  '.repeat(item.depth || 0);
    return `${indent}[L${item.startLine}-L${item.endLine}] ${item.signature}`;
  });
  const remaining = skeleton.items.length - MAX_SKELETON_ITEMS;
  headLines.push(
    `... (共 ${skeleton.items.length} 条声明，已截断显示前 ${MAX_SKELETON_ITEMS} 条，剩余 ${remaining} 条请运行 tokless skeleton CLI 或 grep 定位)`
  );
  return headLines.join('\n');
}

function isClaudeCodePayload(payload, toolName) {
  if (!payload || typeof payload !== 'object') return false;
  if (toolName === 'Read') return true;
  if (!payload.toolCall && (payload.hook_event_name === 'PreToolUse' || typeof payload.tool_name === 'string')) {
    return toolName !== 'read_file' && toolName !== 'view_file';
  }
  return false;
}

function formatHookResponse(verdict, isClaude) {
  if (isClaude) {
    if (verdict.decision === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.reason,
        },
      };
    }
    return {};
  }
  if (verdict.decision === 'deny') {
    return { decision: 'deny', reason: verdict.reason };
  }
  return { decision: 'allow' };
}

function evaluateReadGuard(payloadOrJson, options = {}) {
  try {
    let payload = payloadOrJson;
    if (typeof payloadOrJson === 'string') {
      if (!payloadOrJson.trim()) {
        return { decision: 'allow', host: 'antigravity' };
      }
      payload = JSON.parse(payloadOrJson);
    }

    if (!payload || typeof payload !== 'object') {
      return { decision: 'allow', host: 'antigravity' };
    }

    const toolCall = payload.toolCall ? payload.toolCall : payload;
    const toolName = toolCall && (toolCall.name || toolCall.tool_name);
    const isClaude = isClaudeCodePayload(payload, toolName);
    const host = isClaude ? 'claude' : 'antigravity';

    if (toolName !== 'read_file' && toolName !== 'view_file' && toolName !== 'Read') {
      return { decision: 'allow', host };
    }

    const args = (toolCall && (toolCall.args || toolCall.tool_input)) || {};
    const targetPath = args.Path ?? args.path ?? args.file_path ?? args.AbsolutePath;

    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      return { decision: 'allow', host };
    }

    const baseCwd = options.cwd || payload.cwd;
    const resolvedPath = baseCwd
      ? path.resolve(baseCwd, targetPath)
      : path.resolve(targetPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!GUARDED_CODE_EXTS.has(ext)) {
      return { decision: 'allow', host };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { decision: 'allow', host };
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return { decision: 'allow', host };
    }

    let startNum = parseLineArg(args.StartLine ?? args.startLine ?? args.start_line);
    let endNum = parseLineArg(args.EndLine ?? args.endLine ?? args.end_line);
    const offsetNum = parseLineArg(args.offset ?? args.Offset);
    const limitNum = parseLineArg(args.limit ?? args.Limit);

    if (startNum === null && offsetNum !== null) {
      startNum = Math.max(1, offsetNum);
    }
    if (endNum === null && limitNum !== null && limitNum > 0) {
      const baseStart = startNum !== null ? Math.max(1, startNum) : 1;
      endNum = baseStart + limitNum - 1;
    }

    const hasStart = startNum !== null;
    const hasEnd = endNum !== null;
    const byteOffsetVal = args.ByteOffset ?? args.byteOffset ?? args.byte_offset;
    const hasByteOffset =
      byteOffsetVal !== undefined && byteOffsetVal !== null && byteOffsetVal !== '';
    // 陷阱: 凡传入了显式行号参数或字节偏移一律直接放行（禁设单次跨度上限或拦截 L1~EOF，避免报错重试+拆轮反噬数十万 Cache Read）
    if (hasStart || hasEnd || hasByteOffset) {
      return { decision: 'allow', host };
    }

    const maxLines = getMaxLinesThreshold(options.maxLines);
    const generateFileSkeleton = loadSkeletonGenerator();
    const skeleton = generateFileSkeleton(resolvedPath, { includeHeader: false });

    if (skeleton.totalLines <= maxLines) {
      return { decision: 'allow', host };
    }

    const rangeHint = isClaude
      ? '重新调用 Read 并传入目标区间的 offset 与 limit'
      : '重新调用 read_file 并传入目标区间的 StartLine 和 EndLine';
    const skelBody = formatBoundedSkeleton(skeleton, resolvedPath, maxLines);

    const reason =
      `[tokless 省流护栏] 目标文件共 ${skeleton.totalLines} 行（超过 ${maxLines} 行无行号读取阈值），已返回语法骨架辅助定位。\n` +
      `请根据下方该文件的语法骨架与 [L起-L止] 行号范围，${rangeHint}精准读取所需片段：\n\n` +
      `${skelBody}`;

    return { decision: 'deny', reason, host };
  } catch (_) {
    return { decision: 'allow', host: 'antigravity' };
  }
}

function buildPreToolUseHookConfig(options = {}) {
  const scriptPath = options.scriptPath || READ_GUARD_SCRIPT_PATH;
  const nodeExec = options.nodeExec || 'node';
  const timeout = Number.isInteger(options.timeout) && options.timeout > 0 ? options.timeout : 10;
  return {
    'read-file-guard': {
      enabled: true,
      PreToolUse: [
        {
          matcher: 'read_file|view_file',
          hooks: [
            {
              type: 'command',
              command: `${nodeExec} ${JSON.stringify(scriptPath)}`,
              timeout,
            },
          ],
        },
      ],
    },
  };
}

function buildClaudePreToolUseHookConfig(options = {}) {
  const scriptPath = options.scriptPath || READ_GUARD_SCRIPT_PATH;
  const nodeExec = options.nodeExec || 'node';
  const timeout = Number.isInteger(options.timeout) && options.timeout > 0 ? options.timeout : 10;
  return {
    PreToolUse: [
      {
        matcher: 'Read',
        hooks: [
          {
            type: 'command',
            command: `${nodeExec} ${JSON.stringify(scriptPath)}`,
            timeout,
          },
        ],
      },
    ],
  };
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const rawInput = await readStdin();
  const verdict = evaluateReadGuard(rawInput);
  const outObj = formatHookResponse(verdict, verdict.host === 'claude');
  process.stdout.write(JSON.stringify(outObj) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  GUARDED_CODE_EXTS,
  READ_GUARD_SCRIPT_PATH,
  HOOKS_CONFIG_PATH,
  PLUGIN_MANIFEST_PATH,
  scriptPath: READ_GUARD_SCRIPT_PATH,
  hooksConfigPath: HOOKS_CONFIG_PATH,
  pluginManifestPath: PLUGIN_MANIFEST_PATH,
  getMaxLinesThreshold,
  parseLineArg,
  formatHookResponse,
  evaluateReadGuard,
  checkReadGuard: evaluateReadGuard,
  buildPreToolUseHookConfig,
  buildClaudePreToolUseHookConfig,
};
