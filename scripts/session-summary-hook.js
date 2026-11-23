#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { computeLiveSessionMetrics } = require('../tools/agy-audit/lib/live-metrics');

/**
 * 判断最新一步是否为工具调用中间态（需要静默防刷屏）
 * — 为什么这么写 —
 * 1. 旧版若在 transcript.jsonl 尚未异步落盘首轮 PLANNER_RESPONSE 时找不到记录就返回 false，会误杀首轮状态栏。
 * 2. 改为“仅明确检测到最后一条 PLANNER_RESPONSE 含 tool_calls 且尚未产生最终无工具答复时才跳过”，
 *    其余情况（含首轮异步落盘窗口期）均正常放行展示。
 */
function isMidTurnToolStep(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return false;
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
          return Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
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

function isFinalResponseStep(transcriptPath) {
  return !isMidTurnToolStep(transcriptPath);
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

    const hookEventName = payload.hookEventName || payload.hook_event_name || '';
    const conversationId = payload.conversationId || payload.conversation_id;
    const transcriptPath = payload.transcriptPath || payload.transcript_path;

    // SessionStart 时直接挂出 0 Token 一键监控胶囊按钮，无需点右上角菜单
    if (hookEventName === 'SessionStart') {
      return {
        injectSteps: [
          {
            systemMessage: {
              systemMessage: '',
              metadata: {
                user_markdown:
                  '📊 **Tokless 监控已就绪** &nbsp;|&nbsp; [打开实时会话监控面板](sidecar://agy-tokless/tokless_monitor/)',
              },
            },
          },
        ],
      };
    }

    if (!conversationId) return {};

    // 仅在明确处于工具调用中间态时静默跳过，避免误杀首轮答复
    if (transcriptPath && isMidTurnToolStep(transcriptPath)) {
      return {};
    }

    const metrics = computeLiveSessionMetrics(conversationId);
    const md =
      metrics && metrics.sessionTotal && metrics.sessionTotal.totalCalls > 0
        ? buildSummaryMarkdown(metrics)
        : '📊 **Tokless 会话监控** &nbsp;|&nbsp; [展开实时统计面板](sidecar://agy-tokless/tokless_monitor/)';

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
