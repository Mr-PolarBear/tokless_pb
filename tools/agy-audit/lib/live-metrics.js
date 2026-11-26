'use strict';

const fs = require('fs');
const {
  resolveConversationId,
  getTranscriptInfo,
  getConversationDbPaths,
  listSessions,
} = require('./paths');

const COMPACTION_LIMIT_GEN4 = 512000;
const COMPACTION_LIMIT_GEN3 = 256000;

/**
 * 极简零依赖 Protobuf Wire 格式解码器（仅解析 varint 与 length-delimited 字段）
 * — 为什么这么写 —
 * 1. tokless 坚持纯 Node.js 零外部依赖，不引入 protobufjs。
 * 2. Antigravity conversations/<id>.db 中 steps.metadata 仅需读取 Timestamp(field 1/6/7/8) 与 ModelUsage(field 9) 两层嵌套，
 *    手写 Wire 解码不到 50 行，性能为微秒级且无任何第三方包体积。
 */
function decodeProtoFields(buf) {
  const fields = new Map();
  let pos = 0;
  const len = buf.length;

  const readVarint = () => {
    let result = 0n;
    let shift = 0n;
    while (pos < len) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) return result;
    }
    return result;
  };

  while (pos < len) {
    const tag = Number(readVarint());
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNum === 0) break;

    let value;
    if (wireType === 0) {
      value = readVarint();
    } else if (wireType === 1) {
      if (pos + 8 > len) break;
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 2) {
      const subLen = Number(readVarint());
      if (subLen < 0 || pos + subLen > len) break;
      value = buf.subarray(pos, pos + subLen);
      pos += subLen;
    } else if (wireType === 5) {
      if (pos + 4 > len) break;
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      break;
    }

    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push({ wireType, value });
  }
  return fields;
}

function getFirstVarint(fields, num) {
  const arr = fields.get(num);
  if (!arr || !arr.length || arr[0].wireType !== 0) return null;
  return Number(arr[0].value);
}

function getFirstBytes(fields, num) {
  const arr = fields.get(num);
  if (!arr || !arr.length || arr[0].wireType !== 2) return null;
  return arr[0].value;
}

function decodeTimestampSec(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return null;
  const f = decodeProtoFields(buf);
  const sec = getFirstVarint(f, 1);
  if (sec === null || sec < 1577836800) return null; // 过滤非 Unix 时间戳（2020 年前）
  const nanos = getFirstVarint(f, 2) || 0;
  return sec + nanos / 1e9;
}

function decodeStepMetadata(metaBuf) {
  if (!metaBuf || metaBuf.length === 0) return null;
  const buf = Buffer.isBuffer(metaBuf) ? metaBuf : Buffer.from(metaBuf);
  const top = decodeProtoFields(buf);

  const createdAtSec = decodeTimestampSec(getFirstBytes(top, 1));
  const firstTokenAtSec = decodeTimestampSec(getFirstBytes(top, 6));
  const completedAtSec =
    decodeTimestampSec(getFirstBytes(top, 7)) ?? decodeTimestampSec(getFirstBytes(top, 8));

  let usage = null;
  const usageBytes = getFirstBytes(top, 9);
  if (usageBytes) {
    const uf = decodeProtoFields(usageBytes);
    const inputTokens = getFirstVarint(uf, 2) || 0;
    const outputTokens = getFirstVarint(uf, 3) || 0;
    const cacheReadTokens = getFirstVarint(uf, 5) || 0;
    const thinkingTokens = getFirstVarint(uf, 9) || 0;
    const responseTokens = getFirstVarint(uf, 10) || 0;
    if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
      usage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        thinkingTokens,
        responseTokens,
      };
    }
  }

  return {
    createdAtSec,
    firstTokenAtSec,
    completedAtSec,
    usage,
  };
}

/**
 * 读取 conversations/<id>.db 中全部步骤的原生纳秒时间戳与精确 Token 拆分
 * — 为什么这么写 —
 * 使用 Node 22.5+ 内置的 node:sqlite (DatabaseSync) 只读打开，零外部依赖；
 * 若在旧版本 Node 或 DB 被锁场景下读取失败，则安全返回 null 交由上层降级为 JSONL 模式。
 */
function readDbStepMetrics(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT idx, step_type, metadata FROM steps ORDER BY idx ASC')
      .all();
    const map = new Map();
    for (const row of rows) {
      const decoded = decodeStepMetadata(row.metadata) || {
        createdAtSec: null,
        firstTokenAtSec: null,
        completedAtSec: null,
        usage: null,
      };
      map.set(Number(row.idx), {
        idx: Number(row.idx),
        stepType: Number(row.step_type),
        ...decoded,
      });
    }
    return map;
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close error
      }
    }
  }
}

function detectContextLimit(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (!m) return COMPACTION_LIMIT_GEN4;
  if (/(gemini-2|gemini-3|claude-3|gpt-4o|flash-lite)/i.test(m)) {
    return COMPACTION_LIMIT_GEN3;
  }
  return COMPACTION_LIMIT_GEN4;
}

function parseIsoSec(ts) {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function round(val, digits = 1) {
  if (!Number.isFinite(val)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

function formatCompactTokens(n) {
  const num = Number(n) || 0;
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}k`;
  return `${num}`;
}

/**
 * 计算单次会话的实时监控指标（融合 conversations/<id>.db 与 transcript_full.jsonl）
 * @param {string} [conversationIdOrPrefix] 未传时自动定位最近活跃会话
 * @returns {object|null}
 */
function computeLiveSessionMetrics(conversationIdOrPrefix) {
  let conversationId = conversationIdOrPrefix ? String(conversationIdOrPrefix).trim() : '';
  if (!conversationId) {
    // 兼容上游 v0.5.2+ listSessions({ limit }) 新签名（返回 conversationId 字段）
    const sessions = listSessions({ limit: 1 });
    if (!sessions.length) return null;
    conversationId = sessions[0].conversationId || sessions[0].id || '';
    if (!conversationId) return null;
  } else {
    try {
      conversationId = resolveConversationId(conversationId);
    } catch {
      // 保留原始 ID 以便后续尝试直读
    }
  }

  const transcriptInfo = getTranscriptInfo(conversationId);
  const dbPaths = getConversationDbPaths(conversationId);
  const dbPath = dbPaths.length > 0 ? dbPaths[0] : null;
  const dbSteps = dbPath ? readDbStepMetrics(dbPath) : null;

  if (!transcriptInfo && !dbSteps) {
    return null;
  }

  // 解析 JSONL 拿到轮次边界、模型名与降级数据
  const jsonlRecords = [];
  let modelName = '';
  if (transcriptInfo && fs.existsSync(transcriptInfo.filePath)) {
    const raw = fs.readFileSync(transcriptInfo.filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        jsonlRecords.push(obj);
        if (obj.model) modelName = String(obj.model);
      } catch {
        // 忽略写入中的半截末尾行，保证实时轮询不报错
      }
    }
  }

  // 为什么这么写：/compact (CHECKPOINT) 或本轮末步会实时写入 SQLite WAL，但宿主导出 transcript_full.jsonl
  // 往往延迟到下一轮对话启动。把 DB 中比 JSONL 更新的步骤按序补齐，才能在压缩完成的当秒立即刷新水位。
  let maxJsonlIdx = -1;
  for (const r of jsonlRecords) {
    const idx = Number(r.step_index);
    if (Number.isFinite(idx) && idx > maxJsonlIdx) maxJsonlIdx = idx;
  }
  if (dbSteps && dbSteps.size > 0) {
    const extraIndices = Array.from(dbSteps.keys())
      .filter((idx) => idx > maxJsonlIdx)
      .sort((a, b) => a - b);
    for (const idx of extraIndices) {
      const m = dbSteps.get(idx);
      const mappedType =
        m.stepType === 14
          ? 'USER_INPUT'
          : m.stepType === 15
          ? 'PLANNER_RESPONSE'
          : m.stepType === 23
          ? 'CHECKPOINT'
          : 'GENERIC';
      jsonlRecords.push({
        step_index: idx,
        type: mappedType,
      });
    }
  }

  // 按 USER_INPUT 切分轮次（Turn）
  const turns = [];
  let currentTurn = null;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalPlannerCalls = 0;
  let totalStepsCount = 0;
  let lastContextTokens = 0;
  let prevTurnEndContext = 0;
  let baseSystemTokens = 0;
  let firstUserChars = 0;

  const ensureTurn = (startSec) => {
    if (!currentTurn) {
      currentTurn = {
        turnIndex: turns.length + 1,
        startSec: startSec || null,
        endSec: startSec || null,
        steps: 0,
        plannerCalls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        ttftSecSum: 0,
        streamSecSum: 0,
        modelTotalSecSum: 0,
        lastStepTtftSec: null,
        lastStepStreamSec: null,
        lastStepTotalSec: null,
        lastStepStreamTokPerSec: null,
        lastStepE2eTokPerSec: null,
        endContextTokens: 0,
        isCompacted: false,
        hasExactTiming: false,
        hasExactThinkingSplit: false,
      };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  for (const rec of jsonlRecords) {
    const idx = Number(rec.step_index);
    const dbMeta = dbSteps ? dbSteps.get(idx) : null;
    const stepStartSec = (dbMeta && dbMeta.createdAtSec) ?? parseIsoSec(rec.created_at);
    const stepEndSec =
      (dbMeta && (dbMeta.completedAtSec ?? dbMeta.createdAtSec)) ?? stepStartSec;

    if (rec.type === 'USER_INPUT') {
      if (turns.length === 0 && firstUserChars === 0 && typeof rec.content === 'string') {
        firstUserChars = rec.content.length;
      }
      if (currentTurn && currentTurn.endContextTokens > 0) {
        prevTurnEndContext = currentTurn.endContextTokens;
      }
      currentTurn = null;
      const t = ensureTurn(stepStartSec);
      t.prevEndContextTokens = prevTurnEndContext;
      t.steps++;
      totalStepsCount++;
      continue;
    }

    const t = ensureTurn(stepStartSec);
    if (t.prevEndContextTokens === undefined) {
      t.prevEndContextTokens = prevTurnEndContext;
    }
    t.steps++;
    totalStepsCount++;
    if (stepStartSec !== null && (t.startSec === null || stepStartSec < t.startSec)) {
      t.startSec = stepStartSec;
    }
    if (stepEndSec !== null && (t.endSec === null || stepEndSec > t.endSec)) {
      t.endSec = stepEndSec;
    }

    if (rec.type === 'PLANNER_RESPONSE') {
      const dbUsage = dbMeta && dbMeta.usage;
      const inp = dbUsage ? dbUsage.inputTokens : Number(rec.input_tokens) || 0;
      const cache = dbUsage ? dbUsage.cacheReadTokens : Number(rec.cache_read_tokens) || 0;
      const out = dbUsage ? dbUsage.outputTokens : Number(rec.output_tokens) || 0;

      let thinkTok = 0;
      let respTok = 0;
      if (dbUsage && dbUsage.thinkingTokens + dbUsage.responseTokens > 0) {
        thinkTok = dbUsage.thinkingTokens;
        respTok = dbUsage.responseTokens;
        t.hasExactThinkingSplit = true;
      } else if (out > 0) {
        // DB 不可用时的安全降级：按 thinking 与正文/工具文本长度估算比例
        const thinkLen = typeof rec.thinking === 'string' ? rec.thinking.length : 0;
        const bodyLen =
          (typeof rec.content === 'string' ? rec.content.length : 0) +
          (Array.isArray(rec.tool_calls) ? JSON.stringify(rec.tool_calls).length : 0);
        const denom = thinkLen + bodyLen;
        if (denom > 0) {
          thinkTok = Math.round((out * thinkLen) / denom);
          respTok = Math.max(0, out - thinkTok);
        } else {
          respTok = out;
        }
      }

      if (inp > 0 || cache > 0 || out > 0) {
        totalPlannerCalls++;
        t.plannerCalls++;
        totalInputTokens += inp;
        totalCacheReadTokens += cache;
        totalOutputTokens += out;
        t.inputTokens += inp;
        t.cacheReadTokens += cache;
        t.outputTokens += out;
        t.thinkingTokens += thinkTok;
        t.responseTokens += respTok;

        const ctx = inp + cache;
        if (ctx > 0) {
          if (baseSystemTokens === 0) {
            const estUserTok = Math.round(firstUserChars / 3.5);
            baseSystemTokens = Math.max(4000, ctx - estUserTok);
          }
          lastContextTokens = ctx;
          t.endContextTokens = ctx;
        }

        // 精确 TTFT / 流式耗时 / 生成速度（来自 DB 纳秒时间戳）
        if (
          dbMeta &&
          dbMeta.createdAtSec !== null &&
          dbMeta.firstTokenAtSec !== null &&
          dbMeta.completedAtSec !== null
        ) {
          const ttft = Math.max(0, dbMeta.firstTokenAtSec - dbMeta.createdAtSec);
          const stream = Math.max(0, dbMeta.completedAtSec - dbMeta.firstTokenAtSec);
          const total = Math.max(0, dbMeta.completedAtSec - dbMeta.createdAtSec);
          t.hasExactTiming = true;
          t.ttftSecSum += ttft;
          t.streamSecSum += stream;
          t.modelTotalSecSum += total;
          t.lastStepTtftSec = ttft;
          t.lastStepStreamSec = stream;
          t.lastStepTotalSec = total;
          t.lastStepStreamTokPerSec = stream > 0.05 ? out / stream : 0;
          t.lastStepE2eTokPerSec = total > 0.05 ? out / total : 0;
        }
      }
    } else if (rec.type === 'CHECKPOINT') {
      // 为什么这么写：CHECKPOINT 步（/compact 或自动压缩）的 input_tokens 是被压缩的旧历史，
      // output_tokens / responseTokens 才是压缩后的新摘要。按“系统固定底座 + 新摘要”立即重算水位，
      // 无需等用户发下一句话就能实时看到压缩降水位效果。
      const dbUsage = dbMeta && dbMeta.usage;
      const inp = dbUsage ? dbUsage.inputTokens : Number(rec.input_tokens) || 0;
      const cache = dbUsage ? dbUsage.cacheReadTokens : Number(rec.cache_read_tokens) || 0;
      const out = dbUsage ? dbUsage.outputTokens : Number(rec.output_tokens) || 0;
      const summaryTok =
        dbUsage && dbUsage.responseTokens > 0
          ? dbUsage.responseTokens
          : out > 0
          ? out
          : typeof rec.content === 'string'
          ? Math.round(rec.content.length / 3.5)
          : 0;

      if (inp > 0 || cache > 0 || out > 0) {
        totalPlannerCalls++;
        t.plannerCalls++;
        totalInputTokens += inp;
        totalCacheReadTokens += cache;
        totalOutputTokens += out;
        t.inputTokens += inp;
        t.cacheReadTokens += cache;
        t.outputTokens += out;
        const thinkTok = dbUsage ? dbUsage.thinkingTokens : 0;
        const respTok = dbUsage && dbUsage.responseTokens > 0 ? dbUsage.responseTokens : out;
        t.thinkingTokens += thinkTok;
        t.responseTokens += respTok;
      }

      const estimatedBase = baseSystemTokens > 0 ? baseSystemTokens : 18000;
      const postCompactCtx = estimatedBase + summaryTok;
      if (t.endContextTokens > postCompactCtx) {
        // 若同一轮内发生自动压缩，以压缩前本轮最高水位作为净增对比基准
        t.prevEndContextTokens = t.endContextTokens;
      }
      lastContextTokens = postCompactCtx;
      t.endContextTokens = postCompactCtx;
      t.isCompacted = true;

      if (dbMeta && dbMeta.createdAtSec !== null && dbMeta.completedAtSec !== null) {
        const total = Math.max(0, dbMeta.completedAtSec - dbMeta.createdAtSec);
        t.modelTotalSecSum += total;
        if (dbMeta.firstTokenAtSec !== null) {
          const ttft = Math.max(0, dbMeta.firstTokenAtSec - dbMeta.createdAtSec);
          const stream = Math.max(0, dbMeta.completedAtSec - dbMeta.firstTokenAtSec);
          t.hasExactTiming = true;
          t.ttftSecSum += ttft;
          t.streamSecSum += stream;
        }
      }
    }
  }

  const contextLimit = detectContextLimit(modelName);
  const totalPromptTokens = totalInputTokens + totalCacheReadTokens;
  const avgCacheHitPct =
    totalPromptTokens > 0 ? round((totalCacheReadTokens / totalPromptTokens) * 100, 1) : 0;
  const contextPct =
    contextLimit > 0 ? round((lastContextTokens / contextLimit) * 100, 1) : 0;

  // 组装最新活跃轮次数据
  const latest = turns.length > 0 ? turns[turns.length - 1] : null;
  let currentTurnSummary = null;
  if (latest) {
    const turnPrompt = latest.inputTokens + latest.cacheReadTokens;
    const turnCacheHitPct =
      turnPrompt > 0 ? round((latest.cacheReadTokens / turnPrompt) * 100, 1) : 0;
    const netDeltaTokens =
      latest.endContextTokens > 0
        ? latest.endContextTokens - (latest.prevEndContextTokens || 0)
        : 0;
    const turnElapsedSec =
      latest.startSec !== null && latest.endSec !== null
        ? Math.max(0, latest.endSec - latest.startSec)
        : latest.modelTotalSecSum;

    // 响应耗时与速度：优先展示本轮汇总（或末步有效值）
    const ttftSec = latest.hasExactTiming ? latest.ttftSecSum : 0;
    const streamSec = latest.hasExactTiming ? latest.streamSecSum : 0;
    const modelTotalSec = latest.hasExactTiming ? latest.modelTotalSecSum : 0;
    const streamTokPerSec =
      latest.hasExactTiming && streamSec > 0.05 ? latest.outputTokens / streamSec : 0;
    const e2eTokPerSec =
      latest.hasExactTiming && modelTotalSec > 0.05 ? latest.outputTokens / modelTotalSec : 0;

    const outTotal = latest.thinkingTokens + latest.responseTokens;
    const thinkingPct = outTotal > 0 ? Math.round((latest.thinkingTokens / outTotal) * 100) : 0;
    const responsePct = outTotal > 0 ? 100 - thinkingPct : 0;

    currentTurnSummary = {
      turnIndex: latest.turnIndex,
      totalSteps: latest.steps,
      plannerCalls: latest.plannerCalls,
      turnElapsedSec: round(turnElapsedSec, 0),
      streamTokPerSec: round(streamTokPerSec, 1),
      e2eTokPerSec: round(e2eTokPerSec, 1),
      ttftSec: round(ttftSec, 2),
      streamSec: round(streamSec, 2),
      modelTotalSec: round(modelTotalSec, 2),
      netDeltaTokens,
      netDeltaFormatted: `${netDeltaTokens >= 0 ? '+' : ''}${formatCompactTokens(netDeltaTokens)}`,
      turnCacheHitPct,
      thinkingTokens: latest.thinkingTokens,
      responseTokens: latest.responseTokens,
      thinkingPct,
      responsePct,
      isCompacted: Boolean(latest.isCompacted),
      hasExactTiming: latest.hasExactTiming,
      hasExactThinkingSplit: latest.hasExactThinkingSplit,
    };
  }

  const recentTurns = turns.slice(-8).reverse().map((t) => {
    const tp = t.inputTokens + t.cacheReadTokens;
    const delta =
      t.endContextTokens > 0 ? t.endContextTokens - (t.prevEndContextTokens || 0) : 0;
    const elapsed =
      t.startSec !== null && t.endSec !== null ? Math.max(0, t.endSec - t.startSec) : 0;
    return {
      turnIndex: t.turnIndex,
      steps: t.steps,
      plannerCalls: t.plannerCalls,
      elapsedSec: round(elapsed, 0),
      endContextTokens: t.endContextTokens,
      netDeltaTokens: delta,
      isCompacted: Boolean(t.isCompacted),
      cacheHitPct: tp > 0 ? round((t.cacheReadTokens / tp) * 100, 1) : 0,
      streamTokPerSec:
        t.hasExactTiming && t.streamSecSum > 0.05
          ? round(t.outputTokens / t.streamSecSum, 1)
          : 0,
    };
  });

  return {
    conversationId,
    modelName: modelName || 'unknown',
    dataSource: dbSteps && transcriptInfo ? 'db+jsonl' : dbSteps ? 'db' : 'jsonl',
    updatedAt: new Date().toISOString(),
    currentTurn: currentTurnSummary,
    sessionTotal: {
      totalTurns: turns.length,
      totalCalls: totalPlannerCalls,
      totalSteps: totalStepsCount,
      currentContextTokens: lastContextTokens,
      currentContextFormatted: formatCompactTokens(lastContextTokens),
      contextLimit,
      contextLimitFormatted: formatCompactTokens(contextLimit),
      contextPct,
      avgCacheHitPct,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      totalThroughputTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
    },
    recentTurns,
  };
}

module.exports = {
  decodeProtoFields,
  decodeStepMetadata,
  readDbStepMetrics,
  computeLiveSessionMetrics,
  formatCompactTokens,
};
