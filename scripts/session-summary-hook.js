#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { computeLiveSessionMetrics } = require('../tools/agy-audit/lib/live-metrics');

/**
 * 读取 transcript 末尾判断最新 PLANNER_RESPONSE 是否已结束本轮（无 tool_calls）
 * — 为什么这么写 —
 * PostInvocation 在每次模型调用后都会触发；若中间步骤有 tool_calls 也注入卡片会造成多步刷屏。
 * 仅在模型无 tool_calls（即已向用户输出最终答复）时注入一行免 Token 状态栏 + Sidecar 胶囊按钮。
 */
function isFinalResponseStep(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return true;
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readSize);
    try {
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || !line.startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'PLANNER_RESPONSE') {
          return !Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0;
        }
      } catch {
        // 忽略截断的首行或残缺行
      }
    }
  } catch {
    return false;
  }
  return false;
}

function buildProgressBar(pct, width = 10) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((clamped / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function buildSummaryMarkdown(metrics) {
  const st = metrics.sessionTotal;
  const ct = metrics.currentTurn;
  const bar = buildProgressBar(st.contextPct, 10);
  const pctInt = Math.round(st.contextPct || 0);

  const parts = [
    `\`${bar}\` **${st.currentContextFormatted}/${st.contextLimitFormatted} (${pctInt}%)**`,
    `平均缓存 **${st.avgCacheHitPct.toFixed(1)}%**`,
  ];

  if (ct) {
    parts.push(`第${ct.turnIndex}轮 ${ct.netDeltaFormatted}`);
    if (ct.hasExactTiming && ct.streamTokPerSec > 0) {
      parts.push(`${ct.streamTokPerSec.toFixed(1)} tok/s · TTFT ${ct.ttftSec.toFixed(2)}s`);
    }
    if (ct.thinkingPct > 0 || ct.responsePct > 0) {
      parts.push(`思维链 ${ct.thinkingPct}%`);
    }
  }

  parts.push('[📊 展开会话总计](sidecar://agy-tokless/tokless_monitor/)');
  return parts.join(' &nbsp;|&nbsp; ');
}

function evaluateSessionSummaryHook(payloadOrJson) {
  try {
    if (process.env.TOKLESS_DISABLE_SUMMARY_BAR === '1') {
      return {};
    }

    let payload = payloadOrJson;
    if (typeof payloadOrJson === 'string') {
      if (!payloadOrJson.trim()) return {};
      payload = JSON.parse(payloadOrJson);
    }
    if (!payload || typeof payload !== 'object') return {};

    const conversationId = payload.conversationId || payload.conversation_id;
    const transcriptPath = payload.transcriptPath || payload.transcript_path;
    if (!conversationId) return {};

    // 仅在本轮最终答复（无 tool_calls）时输出，避免工具调用中间态刷屏
    if (transcriptPath && !isFinalResponseStep(transcriptPath)) {
      return {};
    }

    const metrics = computeLiveSessionMetrics(conversationId);
    if (!metrics || !metrics.sessionTotal || metrics.sessionTotal.totalCalls === 0) {
      return {};
    }

    const md = buildSummaryMarkdown(metrics);
    return {
      injectSteps: [
        {
          systemMessage: {
            // 留空字符串确保不进入模型上下文，实现 0 模型 Token 开销
            systemMessage: '',
            metadata: {
              user_markdown: md,
            },
          },
        },
      ],
    };
  } catch {
    return {};
  }
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
  const out = evaluateSessionSummaryHook(rawInput);
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  isFinalResponseStep,
  buildProgressBar,
  buildSummaryMarkdown,
  evaluateSessionSummaryHook,
};
