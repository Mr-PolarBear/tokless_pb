'use strict';

const fs = require('fs');
const {
  resolveSessionTarget,
  getConversationMeta,
  extractFallbackTitleFromTranscript,
  cleanUserPromptTitle,
  inspectSessionMountedMcp,
} = require('./paths');

const COMPACTION_THRESHOLD_256K = 256000;
const COMPACTION_THRESHOLD_512K = 512000;
const CACHE_CLIFF_MIN_PREV_CONTEXT = 8000;
const CACHE_CLIFF_RETENTION_RATIO = 0.55;
const CACHE_CLIFF_MIN_DROP_TOKENS = 6000;
const CACHE_CLIFF_MIN_INPUT_SPIKE = 5000;
const SHORT_IDLE_TTL_SECONDS = 300; // 5m common implicit prompt cache TTL boundary
const SHORT_IDLE_MAX_RETENTION_RATIO = 0.15; // <=15% retention separates cache eviction from mid-prefix edits
const IDLE_TTL_WARNING_SECONDS = 3000; // ~50m+ (1h cache TTL boundary)
const HEAVY_MCP_NAME_RE = /chrome|devtools|playwright|puppeteer|browser|selenium|figma|github|notion|jira|linear|supabase|slack|postgres/i;
const HEAVY_MCP_EST_TOKENS = 3000;
const STANDARD_MCP_EST_TOKENS = 1200;
const MCP_BRIDGE_TOOL_EST_TOKENS = 80; // ~80 tokens per bridge tool schema (call_mcp_tool / list_resources / read_resource)
const MCP_EMPTY_SERVER_EST_TOKENS = 15;

function estimateTokens(chars) {
  if (!chars || chars <= 0) return 0;
  return Math.ceil(chars / 3.5);
}

function estimateLazyServerIndexTokens(lazyTools) {
  let sum = 10; // "# <serverName>\nLazy:\n"
  for (const toolName of lazyTools) {
    sum += Math.max(4, Math.ceil((String(toolName || '').length + 2) / 3.5));
  }
  return sum;
}

function estimateMountedMcpServer(srv, fromSessionDb) {
  const isHeavy = HEAVY_MCP_NAME_RE.test(srv.name);
  const eagerCount = Array.isArray(srv.eagerTools) ? srv.eagerTools.length : 0;
  const lazyTools = Array.isArray(srv.lazyTools) ? srv.lazyTools : [];
  const lazyCount = lazyTools.length;

  if (fromSessionDb) {
    if (eagerCount === 0 && lazyCount > 0) {
      return {
        tier: 'lazy',
        loadingMode: 'lazy',
        estimateBasis: 'prompt_index',
        estTokensPerStep: estimateLazyServerIndexTokens(lazyTools)
      };
    }
    if (eagerCount === 0 && lazyCount === 0) {
      return {
        tier: 'lazy',
        loadingMode: 'empty',
        estimateBasis: 'prompt_index',
        estTokensPerStep: MCP_EMPTY_SERVER_EST_TOKENS
      };
    }
    return {
      tier: isHeavy ? 'heavy' : 'standard',
      loadingMode: lazyCount > 0 ? 'mixed' : 'eager',
      estimateBasis: 'name_heuristic',
      estTokensPerStep: isHeavy ? HEAVY_MCP_EST_TOKENS : STANDARD_MCP_EST_TOKENS
    };
  }

  return {
    tier: isHeavy ? 'heavy' : 'standard',
    loadingMode: 'unknown',
    estimateBasis: 'name_heuristic',
    estTokensPerStep: isHeavy ? HEAVY_MCP_EST_TOKENS : STANDARD_MCP_EST_TOKENS
  };
}

function byteLength(str) {
  if (!str) return 0;
  return Buffer.byteLength(str, 'utf8');
}

function isReadFileTool(name) {
  return name === 'read_file' || name === 'view_file';
}

function parseLineNumber(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function hasLineRange(args) {
  if (!args || typeof args !== 'object') return false;
  return (
    parseLineNumber(args.StartLine ?? args.startLine ?? args.start_line) !== null ||
    parseLineNumber(args.EndLine ?? args.endLine ?? args.end_line) !== null ||
    parseLineNumber(args.ByteOffset ?? args.byteOffset ?? args.byte_offset) !== null
  );
}

function computeRequestedSpanLines(args) {
  if (!args || typeof args !== 'object') return null;
  const start = parseLineNumber(args.StartLine ?? args.startLine ?? args.start_line);
  const end = parseLineNumber(args.EndLine ?? args.endLine ?? args.end_line);
  if (start === null && end === null) return null;
  if (start !== null && end !== null) {
    return Math.max(0, end - start);
  }
  if (end !== null && start === null) {
    return Math.max(0, end - 1);
  }
  return null;
}

function parseActualReadSpanFromOutput(contentStr) {
  if (typeof contentStr !== 'string' || !contentStr) return null;
  const m = contentStr.match(/Showing lines\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (!m) return null;
  const s = parseInt(m[1], 10);
  const e = parseInt(m[2], 10);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return e - s;
}

function parseToolExecDurationSec(contentStr) {
  if (typeof contentStr !== 'string' || !contentStr) return null;
  const mCreate = contentStr.match(/Created At:\s*([^\r\n]+)/);
  const mDone = contentStr.match(/Completed At:\s*([^\r\n]+)/);
  if (!mCreate || !mDone) return null;
  const t1 = Date.parse(mCreate[1].trim());
  const t2 = Date.parse(mDone[1].trim());
  if (Number.isNaN(t1) || Number.isNaN(t2) || t2 < t1) return null;
  return Number(((t2 - t1) / 1000).toFixed(2));
}

function computeTimestampDiffSec(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const t1 = Date.parse(startIso);
  const t2 = Date.parse(endIso);
  if (Number.isNaN(t1) || Number.isNaN(t2) || t2 < t1) return null;
  return Number(((t2 - t1) / 1000).toFixed(2));
}

function extractMcpInvocation(name, args) {
  if (!name || typeof name !== 'string') return null;
  const safeArgs = args && typeof args === 'object' ? args : {};

  if (name === 'call_mcp_tool') {
    const serverName = String(safeArgs.ServerName ?? safeArgs.server_name ?? safeArgs.serverName ?? 'unknown_mcp').trim() || 'unknown_mcp';
    const toolName = String(safeArgs.ToolName ?? safeArgs.tool_name ?? safeArgs.toolName ?? '').trim();
    return {
      serverName,
      prefix: `mcp_${serverName}_`,
      toolName: toolName || name,
      callMode: 'lazy_call_mcp_tool'
    };
  }

  if ((name === 'list_resources' || name === 'read_resource') && (safeArgs.ServerName || safeArgs.server_name)) {
    const serverName = String(safeArgs.ServerName ?? safeArgs.server_name).trim();
    return {
      serverName,
      prefix: `mcp_${serverName}_`,
      toolName: name,
      callMode: 'mcp_resource'
    };
  }

  // Eagerly loaded MCP tools in Antigravity: `mcp_<serverName>_<toolName>` or `<serverName>__<toolName>`
  if (name.startsWith('mcp_') && name !== 'mcp_servers') {
    const rest = name.slice(4);
    const sepIdx = rest.indexOf('_');
    if (sepIdx > 0) {
      const serverName = rest.slice(0, sepIdx);
      const toolName = rest.slice(sepIdx + 1);
      return {
        serverName,
        prefix: `mcp_${serverName}_`,
        toolName,
        callMode: 'eager_native_tool'
      };
    }
  }

  if (name.includes('__')) {
    const parts = name.split('__');
    if (parts[0] && parts[1]) {
      const serverName = parts[0].replace(/^mcp_/, '');
      return {
        serverName,
        prefix: `mcp_${serverName}_`,
        toolName: parts.slice(1).join('__'),
        callMode: 'prefixed_tool'
      };
    }
  }

  // Also detect reading MCP schema files from `<appDataDir>/mcp/<serverName>/<toolName>.json`
  if (isReadFileTool(name)) {
    const p = String(safeArgs.Path ?? safeArgs.path ?? '').replace(/\\/g, '/');
    const m = p.match(/\/\.gemini\/(?:antigravity(?:-cli)?)\/mcp\/([^/]+)\/([^/]+)\.json$/i);
    if (m) {
      const serverName = m[1];
      return {
        serverName,
        prefix: `mcp_${serverName}_`,
        toolName: `schema:${m[2]}`,
        callMode: 'mcp_schema_read'
      };
    }
  }

  return null;
}

function formatToolTarget(name, args) {
  if (!args || typeof args !== 'object') return '';
  if (name === 'call_mcp_tool') {
    const srv = args.ServerName ?? args.server_name ?? 'mcp';
    const tl = args.ToolName ?? args.tool_name ?? '';
    const inner = args.Arguments ?? args.arguments ?? {};
    const innerStr = JSON.stringify(inner);
    const snippet = innerStr && innerStr !== '{}' ? ` ${innerStr.slice(0, 60)}${innerStr.length > 60 ? '...' : ''}` : '';
    return `${srv}::${tl}${snippet}`;
  }
  const targetFile = args.Path ?? args.path ?? args.file_path ?? args.AbsolutePath;
  if (targetFile) {
    const start = args.StartLine ?? args.startLine ?? args.start_line;
    const end = args.EndLine ?? args.endLine ?? args.end_line;
    const byteOffset = args.ByteOffset ?? args.byteOffset ?? args.byte_offset;
    if (start !== undefined || end !== undefined) {
      return `${targetFile} [L${start ?? 1}-L${end ?? 'EOF'}]`;
    }
    if (byteOffset !== undefined) {
      return `${targetFile} [ByteOffset:${byteOffset}]`;
    }
    return targetFile;
  }
  if (args.CommandLine || args.command) {
    return args.CommandLine || args.command;
  }
  if (args.query) {
    return `query: ${args.query}`;
  }
  if (args.Prompt) {
    return `prompt: ${String(args.Prompt).slice(0, 80)}`;
  }
  if (args.Description) {
    return String(args.Description).slice(0, 80);
  }
  const raw = JSON.stringify(args);
  return raw.length > 100 ? raw.slice(0, 100) + '...' : raw;
}

function extractTokenUsage(step) {
  const usage = step.usage && typeof step.usage === 'object' ? step.usage : step;
  const input =
    typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage.prompt_tokens === 'number'
        ? usage.prompt_tokens
        : 0;
  const output =
    typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage.completion_tokens === 'number'
        ? usage.completion_tokens
        : 0;
  const cacheRead =
    typeof usage.cache_read_tokens === 'number'
      ? usage.cache_read_tokens
      : typeof usage.cached_tokens === 'number'
        ? usage.cached_tokens
        : 0;
  const hasUsage =
    typeof usage.input_tokens === 'number' ||
    typeof usage.output_tokens === 'number' ||
    typeof usage.cache_read_tokens === 'number' ||
    typeof usage.prompt_tokens === 'number';
  return { input, output, cacheRead, hasUsage };
}

function extractStepModel(step) {
  if (!step || typeof step !== 'object') return null;
  const candidates = [
    step.model,
    step.model_name,
    step.modelName,
    step.usage && step.usage.model,
    step.metadata && step.metadata.model
  ];
  for (const val of candidates) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

function computeIdleSeconds(prevIso, currIso) {
  if (!prevIso || !currIso) return null;
  const t1 = Date.parse(prevIso);
  const t2 = Date.parse(currIso);
  if (Number.isNaN(t1) || Number.isNaN(t2) || t2 < t1) return null;
  return Math.round((t2 - t1) / 1000);
}

function analyzeSession(idOrPrefixOrPath, options = {}) {
  const target = resolveSessionTarget(idOrPrefixOrPath, options);
  const { conversationId, transcriptInfo: info } = target;
  if (!info) {
    throw new Error(`Transcript file not found for conversation: ${idOrPrefixOrPath}`);
  }

  const rawContent = fs.readFileSync(info.filePath, 'utf8');
  const rawLines = rawContent.split('\n').filter(l => l.trim().length > 0);
  const steps = [];
  for (const line of rawLines) {
    try {
      steps.push(JSON.parse(line));
    } catch {
      // Skip malformed line
    }
  }

  let totalTurns = 0;
  let plannerSteps = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let postWarmupInputTokens = 0;
  let postWarmupCacheReadTokens = 0;
  let coldStartInputTokens = 0;
  let usageFieldSteps = 0;
  let peakContextTokens = 0;
  let peakContextStepIndex = null;
  let lastStepContextTokens = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let fallbackTitle = '';

  const checkpoints = [];
  let pendingCheckpoint = null;
  const cacheCliffs = [];
  let prevUsageStep = null;
  let sawCheckpointSincePrevUsage = false;
  let sawSettingsChangeSincePrevUsage = false;
  const modelUsageMap = new Map();
  let modelSwitchCount = 0;

  const toolCalls = [];
  const pendingQueue = [];
  const toolBreakdown = {};
  const turnStatsMap = new Map();
  const invokedMcpMap = new Map();

  function getOrCreateTurnStat(turnIdx) {
    const key = Math.max(1, turnIdx);
    if (!turnStatsMap.has(key)) {
      turnStatsMap.set(key, {
        turnIndex: key,
        firstStepIndex: null,
        lastStepIndex: null,
        plannerSteps: 0,
        toolCalls: 0,
        startContextTokens: null,
        endContextTokens: null,
        peakContextTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        compactionsInTurn: 0
      });
    }
    return turnStatsMap.get(key);
  }

  // Precompute prefix sums of USER_INPUT and PLANNER_RESPONSE indices so we know remaining turns/calls after any step
  const turnsSeenAtPos = new Array(steps.length).fill(0);
  const plannersSeenAtPos = new Array(steps.length).fill(0);
  let tAcc = 0;
  let pAcc = 0;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].type === 'USER_INPUT') tAcc++;
    if (steps[i].type === 'PLANNER_RESPONSE') pAcc++;
    turnsSeenAtPos[i] = tAcc;
    plannersSeenAtPos[i] = pAcc;
  }
  const grandTotalTurns = tAcc;
  const grandTotalPlanners = pAcc;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!firstTimestamp && step.created_at) firstTimestamp = step.created_at;
    if (step.created_at) lastTimestamp = step.created_at;

    const stepIndex = step.step_index ?? i;
    if (step.type === 'USER_INPUT') {
      totalTurns++;
      const ts = getOrCreateTurnStat(totalTurns);
      if (ts.firstStepIndex === null) ts.firstStepIndex = stepIndex;
      ts.lastStepIndex = stepIndex;
    } else if (step.type === 'USER_SETTINGS_CHANGE') {
      sawSettingsChangeSincePrevUsage = true;
    }

    const currentTurnStat = getOrCreateTurnStat(Math.max(1, totalTurns));
    if (currentTurnStat.firstStepIndex === null) currentTurnStat.firstStepIndex = stepIndex;
    currentTurnStat.lastStepIndex = stepIndex;

    const usage = extractTokenUsage(step);
    const stepContextTokens = usage.input + usage.cacheRead;

    if (usage.hasUsage) {
      usageFieldSteps++;
      totalInputTokens += usage.input;
      totalOutputTokens += usage.output;
      totalCacheReadTokens += usage.cacheRead;

      const currModel = extractStepModel(step);
      if (currModel) {
        if (!modelUsageMap.has(currModel)) {
          modelUsageMap.set(currModel, {
            model: currModel,
            calls: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0
          });
        }
        const mu = modelUsageMap.get(currModel);
        mu.calls++;
        mu.inputTokens += usage.input;
        mu.cacheReadTokens += usage.cacheRead;
        mu.outputTokens += usage.output;
      }

      currentTurnStat.inputTokens += usage.input;
      currentTurnStat.cacheReadTokens += usage.cacheRead;
      currentTurnStat.outputTokens += usage.output;

      if (stepContextTokens > 0) {
        if (currentTurnStat.startContextTokens === null) {
          currentTurnStat.startContextTokens = stepContextTokens;
        }
        currentTurnStat.endContextTokens = stepContextTokens;
        if (stepContextTokens > currentTurnStat.peakContextTokens) {
          currentTurnStat.peakContextTokens = stepContextTokens;
        }

        const prevModel = prevUsageStep ? (prevUsageStep.model || null) : null;
        const isModelSwitched = Boolean(prevModel && currModel && prevModel !== currModel);

        if (!prevUsageStep) {
          coldStartInputTokens = usage.input;
        } else {
          if (isModelSwitched) {
            modelSwitchCount++;
          }
          postWarmupInputTokens += usage.input;
          postWarmupCacheReadTokens += usage.cacheRead;

          // Detect unexpected Prefix Cache cliff (excluding normal CHECKPOINT compactions)
          if (!sawCheckpointSincePrevUsage) {
            const prevContext = prevUsageStep.contextTokens;
            const uncachedGap = prevContext - usage.cacheRead;
            const retentionRatio = prevContext > 0 ? usage.cacheRead / prevContext : 1;

            if (
              prevContext >= CACHE_CLIFF_MIN_PREV_CONTEXT &&
              retentionRatio < CACHE_CLIFF_RETENTION_RATIO &&
              uncachedGap >= CACHE_CLIFF_MIN_DROP_TOKENS &&
              usage.input >= CACHE_CLIFF_MIN_INPUT_SPIKE &&
              usage.input >= uncachedGap * 0.5
            ) {
              const idleSeconds = computeIdleSeconds(prevUsageStep.createdAt, step.created_at);
              const isIdleExpired = idleSeconds !== null && idleSeconds >= IDLE_TTL_WARNING_SECONDS;
              const isShortIdleEvicted =
                idleSeconds !== null &&
                idleSeconds >= SHORT_IDLE_TTL_SECONDS &&
                idleSeconds < IDLE_TTL_WARNING_SECONDS &&
                retentionRatio <= SHORT_IDLE_MAX_RETENTION_RATIO;
              const isSameKnownModel = Boolean(prevModel && currModel && prevModel === currModel);
              let reasonCode = 'prefix_mutated_or_evicted';
              let reason = idleSeconds !== null && idleSeconds >= SHORT_IDLE_TTL_SECONDS
                ? `前缀变动或局部缓存失效 (距上一步间隔 ${(idleSeconds / 60).toFixed(1)} 分钟，仍复用 ${(retentionRatio * 100).toFixed(1)}% 历史前缀，排查动态规则/工具变更)`
                : `前缀变动或缓存驱逐 (仅复用 ${(retentionRatio * 100).toFixed(1)}% 历史前缀，排查动态规则/工具变更)`;

              if (isIdleExpired) {
                reasonCode = 'idle_ttl_expired';
                const switchSuffix = isModelSwitched ? `，且同时切换模型 (${prevModel} → ${currModel})` : '';
                reason = `闲置超时导致缓存过期 (距上一步间隔 ${(idleSeconds / 60).toFixed(1)} 分钟，超出缓存保活窗口${switchSuffix})`;
              } else if (isModelSwitched) {
                reasonCode = 'model_switch';
                const switchSource = sawSettingsChangeSincePrevUsage ? '手动/设置切换模型' : '双模型/Orchestrator 自动切换';
                const idleSuffix = idleSeconds !== null && idleSeconds >= SHORT_IDLE_TTL_SECONDS
                  ? `，距上一步间隔 ${(idleSeconds / 60).toFixed(1)} 分钟`
                  : '';
                reason = `${switchSource} (${prevModel} → ${currModel}${idleSuffix}) 导致跨模型前缀重算`;
              } else if (sawSettingsChangeSincePrevUsage && !(isSameKnownModel && isShortIdleEvicted)) {
                reasonCode = 'settings_or_model_switch';
                const idleSuffix = idleSeconds !== null && idleSeconds >= SHORT_IDLE_TTL_SECONDS
                  ? `，距上一步间隔 ${(idleSeconds / 60).toFixed(1)} 分钟`
                  : '';
                reason = `会话中途切换模型或设置 (USER_SETTINGS_CHANGE${idleSuffix}) 导致前缀重算`;
              } else if (isShortIdleEvicted) {
                reasonCode = 'short_idle_cache_evicted';
                const settingsSuffix = sawSettingsChangeSincePrevUsage ? '，期间含非模型设置变更' : '';
                reason = `疑似短窗口缓存过期/云端驱逐 (距上一步间隔 ${(idleSeconds / 60).toFixed(1)} 分钟，超过常见 ~5 分钟隐式缓存保活窗，仅复用 ${(retentionRatio * 100).toFixed(1)}% 前缀${settingsSuffix})`;
              }

              const estRebilledTokens = Math.min(usage.input, Math.max(0, uncachedGap));
              cacheCliffs.push({
                index: cacheCliffs.length + 1,
                prevStepIndex: prevUsageStep.stepIndex,
                stepIndex,
                turnIndex: Math.max(1, totalTurns),
                createdAt: step.created_at || null,
                idleSeconds,
                prevModel,
                currModel,
                isModelSwitch: isModelSwitched,
                prevContextTokens: prevContext,
                prevCacheReadTokens: prevUsageStep.cacheRead,
                currCacheReadTokens: usage.cacheRead,
                currInputTokens: usage.input,
                currContextTokens: stepContextTokens,
                cacheDropTokens: Math.max(0, uncachedGap),
                retentionPct: Number((retentionRatio * 100).toFixed(1)),
                estRebilledTokens,
                reasonCode,
                reason
              });
            }
          }
        }

        if (stepContextTokens > peakContextTokens) {
          peakContextTokens = stepContextTokens;
          peakContextStepIndex = stepIndex;
        }
        if (pendingCheckpoint && step.type !== 'CHECKPOINT') {
          pendingCheckpoint.postCompactionTokens = stepContextTokens;
          pendingCheckpoint = null;
        }
        lastStepContextTokens = stepContextTokens;

        prevUsageStep = {
          stepIndex,
          turnIndex: Math.max(1, totalTurns),
          input: usage.input,
          cacheRead: usage.cacheRead,
          contextTokens: stepContextTokens,
          createdAt: step.created_at || null,
          model: currModel
        };
        sawCheckpointSincePrevUsage = false;
        sawSettingsChangeSincePrevUsage = false;
      }
    }

    if (step.type === 'CHECKPOINT') {
      sawCheckpointSincePrevUsage = true;
      currentTurnStat.compactionsInTurn++;
      const contentStr = typeof step.content === 'string' ? step.content : '';
      const preTokens = stepContextTokens > 0 ? stepContextTokens : lastStepContextTokens;
      const cpRecord = {
        index: checkpoints.length + 1,
        stepIndex,
        createdAt: step.created_at || null,
        preCompactionTokens: preTokens,
        postCompactionTokens: null,
        summaryChars: contentStr.length,
        summaryEstTokens: estimateTokens(contentStr.length)
      };
      checkpoints.push(cpRecord);
      pendingCheckpoint = cpRecord;
    } else if (step.type === 'PLANNER_RESPONSE') {
      plannerSteps++;
      currentTurnStat.plannerSteps++;

      if (Array.isArray(step.tool_calls)) {
        const batchLen = step.tool_calls.length;
        for (let tcIdx = 0; tcIdx < batchLen; tcIdx++) {
          const tc = step.tool_calls[tcIdx];
          const name = tc.name || tc.toolName || 'unknown_tool';
          const args = tc.args || tc.parameters || {};
          const argsStr = JSON.stringify(args);
          const inputChars = argsStr.length;
          const inputBytes = byteLength(argsStr);
          const inputEstTokens = estimateTokens(inputChars);

          const isRead = isReadFileTool(name);
          const ranged = isRead ? hasLineRange(args) : false;
          const reqSpan = isRead ? computeRequestedSpanLines(args) : null;

          const mcpCall = extractMcpInvocation(name, args);
          if (mcpCall) {
            if (!invokedMcpMap.has(mcpCall.serverName)) {
              invokedMcpMap.set(mcpCall.serverName, {
                name: mcpCall.serverName,
                prefix: mcpCall.prefix,
                callCount: 0,
                invokedTools: new Set(),
                callModes: new Set()
              });
            }
            const entry = invokedMcpMap.get(mcpCall.serverName);
            entry.callCount++;
            if (mcpCall.toolName) entry.invokedTools.add(mcpCall.toolName);
            entry.callModes.add(mcpCall.callMode);
          }

          currentTurnStat.toolCalls++;

          const record = {
            callPos: i,
            resultPos: i,
            stepIndex: step.step_index ?? i,
            resultStepIndex: null,
            turnIndex: Math.max(1, totalTurns),
            plannerCreatedAt: step.created_at || null,
            resultCreatedAt: null,
            isFirstInPlannerBatch: tcIdx === 0,
            toolName: name,
            target: formatToolTarget(name, args),
            isReadFile: isRead,
            isBlindRead: isRead && !ranged,
            isRangedRead: isRead && ranged,
            requestedSpanLines: reqSpan,
            actualSpanLines: null,
            effectiveSpanLines: reqSpan,
            execDurationSec: null,
            stepWallSec: null,
            durationSec: 0,
            durationSource: 'unavailable',
            inputChars,
            inputBytes,
            inputEstTokens,
            outputChars: 0,
            outputBytes: 0,
            outputEstTokens: 0
          };

          toolCalls.push(record);
          pendingQueue.push(record);

          if (!toolBreakdown[name]) {
            toolBreakdown[name] = {
              count: 0,
              inputChars: 0,
              inputBytes: 0,
              inputEstTokens: 0,
              outputChars: 0,
              outputBytes: 0,
              outputEstTokens: 0
            };
          }
          toolBreakdown[name].count++;
          toolBreakdown[name].inputChars += inputChars;
          toolBreakdown[name].inputBytes += inputBytes;
          toolBreakdown[name].inputEstTokens += inputEstTokens;
        }
      }
    } else if (step.type === 'GENERIC') {
      // Match the oldest pending tool call from the nearest preceding PLANNER_RESPONSE when possible
      const rec = pendingQueue.shift();
      if (rec) {
        const outStr = typeof step.content === 'string' ? step.content : JSON.stringify(step.content || '');
        const outChars = outStr.length;
        const outBytes = byteLength(outStr);
        const outEstTokens = estimateTokens(outChars);

        rec.resultPos = i;
        rec.resultStepIndex = step.step_index ?? i;
        rec.resultCreatedAt = step.created_at || null;
        rec.outputChars = outChars;
        rec.outputBytes = outBytes;
        rec.outputEstTokens = outEstTokens;

        // Parse exact tool execution duration (Created At -> Completed At), and end-to-end step wall time
        const execSec = parseToolExecDurationSec(outStr);
        const wallSec = computeTimestampDiffSec(rec.plannerCreatedAt, rec.resultCreatedAt);
        rec.execDurationSec = execSec;
        // Guard against out-of-order queue skew if an earlier step errored out without emitting GENERIC
        const hasInterveningError = steps.slice(rec.callPos + 1, i).some(s => s.type === 'ERROR_MESSAGE');
        rec.stepWallSec = !hasInterveningError ? wallSec : null;

        if (execSec !== null && rec.stepWallSec !== null) {
          // stepWallSec includes LLM streaming generation of large tool arguments + tool execution
          rec.durationSec = rec.isFirstInPlannerBatch ? Math.max(execSec, rec.stepWallSec) : execSec;
          rec.durationSource = rec.durationSec > execSec ? 'step_wall+exec' : 'tool_exec';
        } else if (execSec !== null) {
          rec.durationSec = execSec;
          rec.durationSource = 'tool_exec';
        } else if (rec.stepWallSec !== null) {
          rec.durationSec = rec.stepWallSec;
          rec.durationSource = 'step_wall';
        }

        if (rec.isReadFile) {
          const actualSpan = parseActualReadSpanFromOutput(outStr);
          rec.actualSpanLines = actualSpan;
          const effSpan = rec.requestedSpanLines !== null ? rec.requestedSpanLines : actualSpan;
          rec.effectiveSpanLines = effSpan;
        }

        const bd = toolBreakdown[rec.toolName];
        if (bd) {
          bd.outputChars += outChars;
          bd.outputBytes += outBytes;
          bd.outputEstTokens += outEstTokens;
        }
      }
    } else if (step.type === 'ERROR_MESSAGE') {
      // Clear orphaned pending tool calls from aborted planner step so subsequent GENERIC results align cleanly
      pendingQueue.length = 0;
    }
  }

  let blindReadCount = 0;
  let rangedReadCount = 0;
  let totalToolInputChars = 0;
  let totalToolInputBytes = 0;
  let totalToolOutputChars = 0;
  let totalToolOutputBytes = 0;

  for (const tc of toolCalls) {
    if (tc.isBlindRead) blindReadCount++;
    if (tc.isRangedRead) rangedReadCount++;
    totalToolInputChars += tc.inputChars;
    totalToolInputBytes += tc.inputBytes;
    totalToolOutputChars += tc.outputChars;
    totalToolOutputBytes += tc.outputBytes;

    const refPos = tc.resultPos;
    tc.remainingTurns = Math.max(0, grandTotalTurns - turnsSeenAtPos[refPos]);
    tc.remainingPlannerSteps = Math.max(0, grandTotalPlanners - plannersSeenAtPos[refPos]);
    tc.estSnowballTokens = tc.outputEstTokens * tc.remainingPlannerSteps;
  }

  const sortedByDuration = [...toolCalls]
    .filter(tc => typeof tc.durationSec === 'number' && tc.durationSec >= 0)
    .sort((a, b) => b.durationSec - a.durationSec || (b.execDurationSec ?? 0) - (a.execDurationSec ?? 0));

  const slowestSteps = sortedByDuration.slice(0, 3).map((tc, idx) => ({
    rank: idx + 1,
    stepIndex: tc.stepIndex,
    resultStepIndex: tc.resultStepIndex,
    turnIndex: tc.turnIndex,
    toolName: tc.toolName,
    target: tc.target,
    durationSec: tc.durationSec,
    execDurationSec: tc.execDurationSec,
    stepWallSec: tc.stepWallSec,
    durationSource: tc.durationSource,
    outputBytes: tc.outputBytes,
    outputEstTokens: tc.outputEstTokens
  }));

  // Build per-turn context net growth & cache hit rate breakdown
  const turnDeltas = [];
  let prevTurnEndContext = 0;
  const sortedTurnEntries = Array.from(turnStatsMap.values()).sort((a, b) => a.turnIndex - b.turnIndex);
  for (const t of sortedTurnEntries) {
    const endCtx = t.endContextTokens !== null ? t.endContextTokens : prevTurnEndContext;
    const startCtx = t.startContextTokens !== null ? t.startContextTokens : prevTurnEndContext;
    const netContextDeltaTokens = t.endContextTokens !== null ? endCtx - prevTurnEndContext : 0;
    const billed = t.inputTokens + t.cacheReadTokens;
    const turnCacheHitRatePct = billed > 0 ? Number(((t.cacheReadTokens / billed) * 100).toFixed(1)) : 0;

    turnDeltas.push({
      turnIndex: t.turnIndex,
      firstStepIndex: t.firstStepIndex,
      lastStepIndex: t.lastStepIndex,
      plannerSteps: t.plannerSteps,
      toolCalls: t.toolCalls,
      prevTurnEndContextTokens: prevTurnEndContext,
      startContextTokens: startCtx,
      endContextTokens: endCtx,
      peakContextTokens: t.peakContextTokens,
      netContextDeltaTokens,
      inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens,
      outputTokens: t.outputTokens,
      cacheHitRatePct: turnCacheHitRatePct,
      compactionsInTurn: t.compactionsInTurn
    });

    if (t.endContextTokens !== null) {
      prevTurnEndContext = t.endContextTokens;
    }
  }

  // Merge session DB `<mcp_servers>` prompt inspection + transcript actual MCP invocations
  const dbMcpInfo = inspectSessionMountedMcp(conversationId, info.filePath, options);
  const mergedMcpMap = new Map();

  for (const srv of dbMcpInfo.servers) {
    const est = estimateMountedMcpServer(srv, true);
    mergedMcpMap.set(srv.name, {
      name: srv.name,
      prefix: srv.prefix,
      mountedInPrompt: true,
      invokedInTranscript: false,
      callCount: 0,
      eagerToolCount: srv.eagerTools.length,
      lazyToolCount: srv.lazyTools.length,
      invokedTools: [],
      tier: est.tier,
      loadingMode: est.loadingMode,
      estimateBasis: est.estimateBasis,
      estTokensPerStep: est.estTokensPerStep
    });
  }

  for (const [srvName, inv] of invokedMcpMap.entries()) {
    if (!mergedMcpMap.has(srvName)) {
      const est = estimateMountedMcpServer({ name: srvName }, false);
      mergedMcpMap.set(srvName, {
        name: srvName,
        prefix: inv.prefix,
        mountedInPrompt: true,
        invokedInTranscript: true,
        callCount: inv.callCount,
        eagerToolCount: 0,
        lazyToolCount: 0,
        invokedTools: Array.from(inv.invokedTools),
        tier: est.tier,
        loadingMode: est.loadingMode,
        estimateBasis: est.estimateBasis,
        estTokensPerStep: est.estTokensPerStep
      });
    } else {
      const existing = mergedMcpMap.get(srvName);
      existing.invokedInTranscript = true;
      existing.callCount = inv.callCount;
      existing.invokedTools = Array.from(inv.invokedTools);
    }
  }

  const mountedMcpServers = Array.from(mergedMcpMap.values());
  const mountedMcpPrefixes = mountedMcpServers.map(s => s.prefix);
  const unusedMcpServerObjs = mountedMcpServers.filter(s => s.callCount === 0);
  const unusedMountedMcpServers = unusedMcpServerObjs.map(s => s.name);
  const hasAnyLazyServer = mountedMcpServers.some(s => s.lazyToolCount > 0);
  const effectiveBridgeDecls = dbMcpInfo.detectedFromSessionDb && mountedMcpServers.length > 0
    ? (dbMcpInfo.bridgeToolDeclCount > 0 ? dbMcpInfo.bridgeToolDeclCount : (hasAnyLazyServer ? 3 : 0))
    : 0;
  const sharedPreambleTokens = dbMcpInfo.detectedFromSessionDb && mountedMcpServers.length > 0
    ? estimateTokens(dbMcpInfo.mcpPreambleChars || 0)
    : 0;
  const sharedBridgeTokens = effectiveBridgeDecls * MCP_BRIDGE_TOOL_EST_TOKENS;
  const sharedOverheadEstTokensPerStep = sharedPreambleTokens + sharedBridgeTokens;

  const serversEstTokensPerStep = mountedMcpServers.reduce((acc, s) => acc + s.estTokensPerStep, 0);
  const estMountedMcpTokensPerStep = serversEstTokensPerStep + sharedOverheadEstTokensPerStep;
  const stepMultiplier = Math.max(1, plannerSteps);
  const estMountedMcpSessionTaxTokens = estMountedMcpTokensPerStep * stepMultiplier;

  const allMountedUnused = mountedMcpServers.length > 0 && unusedMcpServerObjs.length === mountedMcpServers.length;
  const unusedServersEstTokensPerStep = unusedMcpServerObjs.reduce((acc, s) => acc + s.estTokensPerStep, 0);
  const unusedSharedOverheadPerStep = allMountedUnused ? sharedOverheadEstTokensPerStep : 0;
  const unusedEstTokensPerStep = unusedServersEstTokensPerStep + unusedSharedOverheadPerStep;
  const unusedEstSessionTaxTokens = unusedEstTokensPerStep * stepMultiplier;
  const unusedLazyOnly =
    unusedMcpServerObjs.length > 0 &&
    unusedMcpServerObjs.every(s => s.loadingMode === 'lazy' || s.loadingMode === 'empty');

  const mcpAudit = {
    detectionSource: dbMcpInfo.detectedFromSessionDb
      ? (invokedMcpMap.size > 0 ? 'session_db+transcript' : 'session_db')
      : (invokedMcpMap.size > 0 ? 'transcript_calls' : 'transcript_only'),
    detectedFromSessionDb: dbMcpInfo.detectedFromSessionDb,
    mountedCount: mountedMcpServers.length,
    invokedServerCount: invokedMcpMap.size,
    totalMcpToolCalls: Array.from(invokedMcpMap.values()).reduce((s, x) => s + x.callCount, 0),
    prefixes: mountedMcpPrefixes,
    unusedServerNames: unusedMountedMcpServers,
    sharedOverheadEstTokensPerStep,
    estTokensPerStep: estMountedMcpTokensPerStep,
    estSessionTaxTokens: estMountedMcpSessionTaxTokens,
    unusedServersEstTokensPerStep,
    unusedSharedOverheadPerStep,
    unusedEstTokensPerStep,
    unusedEstSessionTaxTokens,
    unusedLazyOnly,
    servers: mountedMcpServers
  };

  const sortedByOutput = [...toolCalls].sort((a, b) => b.outputBytes - a.outputBytes || b.outputChars - a.outputChars);
  const topBloats = sortedByOutput.slice(0, 5).map((tc, idx) => ({
    rank: idx + 1,
    stepIndex: tc.stepIndex,
    resultStepIndex: tc.resultStepIndex,
    turnIndex: tc.turnIndex,
    toolName: tc.toolName,
    target: tc.target,
    isReadFile: tc.isReadFile,
    isBlindRead: tc.isBlindRead,
    isRangedRead: tc.isRangedRead,
    effectiveSpanLines: tc.effectiveSpanLines,
    durationSec: tc.durationSec,
    inputChars: tc.inputChars,
    inputBytes: tc.inputBytes,
    inputEstTokens: tc.inputEstTokens,
    outputChars: tc.outputChars,
    outputBytes: tc.outputBytes,
    outputEstTokens: tc.outputEstTokens,
    remainingTurns: tc.remainingTurns,
    remainingPlannerSteps: tc.remainingPlannerSteps,
    estSnowballTokens: tc.estSnowballTokens
  }));

  const maxSingleStepOutput = topBloats.length > 0 ? topBloats[0] : null;
  const slowestStep = slowestSteps.length > 0 ? slowestSteps[0] : null;

  let durationSeconds = 0;
  if (firstTimestamp && lastTimestamp) {
    const startMs = new Date(firstTimestamp).getTime();
    const endMs = new Date(lastTimestamp).getTime();
    if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
      durationSeconds = Math.round((endMs - startMs) / 1000);
    }
  }

  if (!fallbackTitle) {
    for (const s of steps) {
      if (s && s.type === 'USER_INPUT' && typeof s.content === 'string') {
        const cleaned = cleanUserPromptTitle(s.content);
        if (cleaned) {
          fallbackTitle = cleaned;
          break;
        }
      }
    }
    if (!fallbackTitle) {
      fallbackTitle = extractFallbackTitleFromTranscript(info.filePath);
    }
  }

  const dbMeta = getConversationMeta(conversationId, options);
  const meta = {
    conversationId,
    shortId: conversationId.slice(0, 8),
    title: (dbMeta && dbMeta.title) || fallbackTitle || 'Untitled Session',
    workspace: (dbMeta && dbMeta.workspace) || '',
    source: target.source || 'unknown',
    sourceLabel: target.sourceLabel || '',
    logType: info.logType,
    logFile: info.filePath,
    logBytes: info.bytes,
    firstTimestamp,
    lastTimestamp,
    durationSec: durationSeconds,
    durationSeconds
  };

  const peakContextPct256k = peakContextTokens > 0
    ? Number(((peakContextTokens / COMPACTION_THRESHOLD_256K) * 100).toFixed(1))
    : 0;
  const peakContextPct512k = peakContextTokens > 0
    ? Number(((peakContextTokens / COMPACTION_THRESHOLD_512K) * 100).toFixed(1))
    : 0;
  const totalBilledContextTokens = totalInputTokens + totalCacheReadTokens;
  const totalThroughputTokens = totalBilledContextTokens + totalOutputTokens;
  const cacheHitRatePct = totalBilledContextTokens > 0
    ? Number(((totalCacheReadTokens / totalBilledContextTokens) * 100).toFixed(1))
    : 0;
  const postWarmupTotal = postWarmupInputTokens + postWarmupCacheReadTokens;
  const postWarmupCacheHitRatePct = postWarmupTotal > 0
    ? Number(((postWarmupCacheReadTokens / postWarmupTotal) * 100).toFixed(1))
    : 0;
  const cacheRebilledTokens = cacheCliffs.reduce((s, c) => s + c.estRebilledTokens, 0);
  const cacheCliffBreakdown = {
    model_switch: { count: 0, estRebilledTokens: 0 },
    idle_ttl_expired: { count: 0, estRebilledTokens: 0 },
    short_idle_cache_evicted: { count: 0, estRebilledTokens: 0 },
    settings_or_model_switch: { count: 0, estRebilledTokens: 0 },
    prefix_mutated_or_evicted: { count: 0, estRebilledTokens: 0 }
  };
  for (const cliff of cacheCliffs) {
    if (!cacheCliffBreakdown[cliff.reasonCode]) {
      cacheCliffBreakdown[cliff.reasonCode] = { count: 0, estRebilledTokens: 0 };
    }
    cacheCliffBreakdown[cliff.reasonCode].count++;
    cacheCliffBreakdown[cliff.reasonCode].estRebilledTokens += cliff.estRebilledTokens;
  }
  const modelSwitchCacheCliffCount = cacheCliffBreakdown.model_switch.count;
  const modelSwitchCacheRebilledTokens = cacheCliffBreakdown.model_switch.estRebilledTokens;
  const shortIdleCacheCliffCount = cacheCliffBreakdown.short_idle_cache_evicted.count;
  const shortIdleCacheRebilledTokens = cacheCliffBreakdown.short_idle_cache_evicted.estRebilledTokens;
  const modelBreakdown = Array.from(modelUsageMap.values())
    .map(m => {
      const billed = m.inputTokens + m.cacheReadTokens;
      return {
        model: m.model,
        calls: m.calls,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens,
        outputTokens: m.outputTokens,
        cacheHitRatePct: billed > 0 ? Number(((m.cacheReadTokens / billed) * 100).toFixed(1)) : 0
      };
    })
    .sort((a, b) => (b.inputTokens + b.cacheReadTokens) - (a.inputTokens + a.cacheReadTokens) || b.calls - a.calls || a.model.localeCompare(b.model));

  const netDeltas = turnDeltas.map(t => t.netContextDeltaTokens);
  const maxTurnNetContextDeltaTokens = netDeltas.length > 0 ? Math.max(...netDeltas) : 0;
  const minTurnNetContextDeltaTokens = netDeltas.length > 0 ? Math.min(...netDeltas) : 0;
  const avgTurnNetContextDeltaTokens = netDeltas.length > 0
    ? Math.round(netDeltas.reduce((a, b) => a + b, 0) / netDeltas.length)
    : 0;

  return {
    meta,
    stats: {
      durationSec: durationSeconds,
      durationSeconds,
      totalTurns,
      totalSteps: steps.length,
      plannerSteps,
      totalToolCalls: toolCalls.length,
      blindReadCount,
      rangedReadCount,
      readTotalCount: blindReadCount + rangedReadCount,
      mountedMcpCount: mcpAudit.mountedCount,
      mountedMcpServers: mountedMcpServers.map(s => s.name),
      mountedMcpPrefixes,
      invokedMcpToolCalls: mcpAudit.totalMcpToolCalls,
      mcpUnusedEstTokensPerStep: mcpAudit.unusedEstTokensPerStep,
      mcpUnusedEstSessionTaxTokens: mcpAudit.unusedEstSessionTaxTokens,
      hasUsageMetrics: usageFieldSteps > 0,
      usageFieldSteps,
      distinctModelCount: modelBreakdown.length,
      modelsUsed: modelBreakdown.map(m => m.model),
      modelSwitchCount,
      coldStartInputTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalEffectiveTokens: totalInputTokens + totalOutputTokens,
      totalBilledContextTokens,
      totalThroughputTokens,
      cacheHitRatePct,
      postWarmupCacheHitRatePct,
      cacheCliffCount: cacheCliffs.length,
      cacheRebilledTokens,
      modelSwitchCacheCliffCount,
      modelSwitchCacheRebilledTokens,
      shortIdleCacheCliffCount,
      shortIdleCacheRebilledTokens,
      peakContextTokens,
      peakContextPct256k,
      peakContextPct512k,
      peakContextStepIndex,
      maxTurnNetContextDeltaTokens,
      minTurnNetContextDeltaTokens,
      avgTurnNetContextDeltaTokens,
      compactionThresholdTokens: COMPACTION_THRESHOLD_256K,
      compactionThresholdGen4EstTokens: COMPACTION_THRESHOLD_512K,
      compactionCount: checkpoints.length,
      totalToolInputChars,
      totalToolInputBytes,
      totalToolInputEstTokens: estimateTokens(totalToolInputChars),
      totalToolOutputChars,
      totalToolOutputBytes,
      totalToolOutputEstTokens: estimateTokens(totalToolOutputChars),
      maxSingleStepOutput,
      slowestStep
    },
    slowestSteps,
    mcpAudit,
    turnDeltas,
    checkpoints,
    cacheCliffs,
    modelBreakdown,
    cacheCliffBreakdown,
    toolBreakdown,
    topBloats
  };
}

module.exports = {
  analyzeSession,
  estimateTokens,
  COMPACTION_THRESHOLD_256K,
  COMPACTION_THRESHOLD_512K
};
