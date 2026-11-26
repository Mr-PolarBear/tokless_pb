'use strict';

const { analyzeSession } = require('./analyzer');

function calcDelta(beforeVal, afterVal) {
  const b = beforeVal || 0;
  const a = afterVal || 0;
  const delta = Number((a - b).toFixed(1));
  let savedPct = null;
  if (b > 0) {
    savedPct = Number((((b - a) / b) * 100).toFixed(1));
  } else if (a === 0) {
    savedPct = 0;
  }
  return {
    before: b,
    after: a,
    delta,
    savedPct
  };
}

function compareSessions(idBefore, idAfter, options = {}) {
  const before = analyzeSession(idBefore, options);
  const after = analyzeSession(idAfter, options);

  const bMaxChars = before.stats.maxSingleStepOutput ? before.stats.maxSingleStepOutput.outputChars : 0;
  const aMaxChars = after.stats.maxSingleStepOutput ? after.stats.maxSingleStepOutput.outputChars : 0;
  const bMaxTokens = before.stats.maxSingleStepOutput ? before.stats.maxSingleStepOutput.outputEstTokens : 0;
  const aMaxTokens = after.stats.maxSingleStepOutput ? after.stats.maxSingleStepOutput.outputEstTokens : 0;

  const metrics = {
    durationSec: calcDelta(before.stats.durationSec, after.stats.durationSec),
    totalTurns: calcDelta(before.stats.totalTurns, after.stats.totalTurns),
    totalSteps: calcDelta(before.stats.totalSteps, after.stats.totalSteps),
    plannerSteps: calcDelta(before.stats.plannerSteps, after.stats.plannerSteps),
    totalToolCalls: calcDelta(before.stats.totalToolCalls, after.stats.totalToolCalls),
    readTotalCount: calcDelta(before.stats.readTotalCount, after.stats.readTotalCount),
    blindReadCount: calcDelta(before.stats.blindReadCount, after.stats.blindReadCount),
    rangedReadCount: calcDelta(before.stats.rangedReadCount, after.stats.rangedReadCount),
    totalToolOutputChars: calcDelta(before.stats.totalToolOutputChars, after.stats.totalToolOutputChars),
    totalToolOutputBytes: calcDelta(before.stats.totalToolOutputBytes, after.stats.totalToolOutputBytes),
    totalToolOutputEstTokens: calcDelta(before.stats.totalToolOutputEstTokens, after.stats.totalToolOutputEstTokens),
    maxStepBloatChars: calcDelta(bMaxChars, aMaxChars),
    maxStepBloatEstTokens: calcDelta(bMaxTokens, aMaxTokens),
    totalInputTokens: calcDelta(before.stats.totalInputTokens, after.stats.totalInputTokens),
    totalCacheReadTokens: calcDelta(before.stats.totalCacheReadTokens, after.stats.totalCacheReadTokens),
    totalOutputTokens: calcDelta(before.stats.totalOutputTokens, after.stats.totalOutputTokens),
    totalThroughputTokens: calcDelta(before.stats.totalThroughputTokens, after.stats.totalThroughputTokens),
    cacheHitRatePct: calcDelta(before.stats.cacheHitRatePct, after.stats.cacheHitRatePct),
    cacheCliffCount: calcDelta(before.stats.cacheCliffCount, after.stats.cacheCliffCount),
    modelSwitchCount: calcDelta(before.stats.modelSwitchCount, after.stats.modelSwitchCount),
    modelSwitchCacheCliffCount: calcDelta(before.stats.modelSwitchCacheCliffCount, after.stats.modelSwitchCacheCliffCount),
    shortIdleCacheCliffCount: calcDelta(before.stats.shortIdleCacheCliffCount, after.stats.shortIdleCacheCliffCount),
    shortIdleCacheRebilledTokens: calcDelta(before.stats.shortIdleCacheRebilledTokens, after.stats.shortIdleCacheRebilledTokens),
    mcpUnusedEstSessionTaxTokens: calcDelta(
      before.mcpAudit ? before.mcpAudit.unusedEstSessionTaxTokens : 0,
      after.mcpAudit ? after.mcpAudit.unusedEstSessionTaxTokens : 0
    ),
    peakContextTokens: calcDelta(before.stats.peakContextTokens, after.stats.peakContextTokens),
    peakContextPct256k: calcDelta(before.stats.peakContextPct256k, after.stats.peakContextPct256k),
    compactionCount: calcDelta(before.stats.compactionCount, after.stats.compactionCount)
  };

  return {
    before,
    after,
    metrics
  };
}

module.exports = {
  compareSessions
};
