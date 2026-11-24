'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const {
  decodeStepMetadata,
  computeLiveSessionMetrics,
  formatCompactTokens,
} = require('../tools/agy-audit/lib/live-metrics');
const {
  isFinalResponseStep,
  buildSummaryMarkdown,
} = require('../scripts/session-summary-hook');

function encodeVarint(num) {
  let v = BigInt(num);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function encodeTag(fieldNum, wireType) {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encodeBytesField(fieldNum, buf) {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf]);
}

function encodeVarintField(fieldNum, num) {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(num)]);
}

function encodeTimestamp(sec, nanos) {
  return Buffer.concat([encodeVarintField(1, sec), encodeVarintField(2, nanos)]);
}

test('decodeStepMetadata extracts nanosecond timestamps and thinking/response token split', () => {
  const usageBuf = Buffer.concat([
    encodeVarintField(2, 5000), // input_tokens
    encodeVarintField(3, 1500), // output_tokens
    encodeVarintField(5, 25000), // cache_read_tokens
    encodeVarintField(9, 600), // thinking_output_tokens
    encodeVarintField(10, 900), // response_output_tokens
  ]);

  const metaBuf = Buffer.concat([
    encodeBytesField(1, encodeTimestamp(1795400000, 100_000_000)),
    encodeBytesField(6, encodeTimestamp(1795400002, 600_000_000)),
    encodeBytesField(7, encodeTimestamp(1795400008, 600_000_000)),
    encodeBytesField(9, usageBuf),
  ]);

  const decoded = decodeStepMetadata(metaBuf);
  assert.ok(decoded, 'should decode metadata buffer');
  assert.equal(Math.round((decoded.firstTokenAtSec - decoded.createdAtSec) * 100) / 100, 2.5);
  assert.equal(Math.round((decoded.completedAtSec - decoded.firstTokenAtSec) * 100) / 100, 6.0);
  assert.deepEqual(decoded.usage, {
    inputTokens: 5000,
    outputTokens: 1500,
    cacheReadTokens: 25000,
    thinkingTokens: 600,
    responseTokens: 900,
  });
});

test('session-summary-hook suppresses mid-turn tool calls and formats zero-token markdown bar', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-hook-'));
  try {
    const midPath = path.join(tmpDir, 'mid.jsonl');
    fs.writeFileSync(
      midPath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', args: {} }],
      }) + '\n',
      'utf8'
    );
    assert.equal(isFinalResponseStep(midPath), false);

    const finalPath = path.join(tmpDir, 'final.jsonl');
    fs.writeFileSync(
      finalPath,
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        content: 'done',
      }) + '\n',
      'utf8'
    );
    assert.equal(isFinalResponseStep(finalPath), true);

    const md = buildSummaryMarkdown({
      currentTurn: {
        turnIndex: 41,
        netDeltaFormatted: '+374k',
        hasExactTiming: true,
        streamTokPerSec: 112.3,
        ttftSec: 6.67,
        thinkingPct: 40,
        responsePct: 60,
      },
      sessionTotal: {
        currentContextFormatted: formatCompactTokens(366000),
        contextLimitFormatted: formatCompactTokens(512000),
        contextPct: 71.5,
        avgCacheHitPct: 96.6,
      },
    });
    assert.ok(md.includes('366k/512k (72%)'));
    assert.ok(md.includes('96.6%'));
    assert.ok(md.includes('sidecar://agy-tokless/tokless_monitor/'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('install.js copies sidecars/tokless_monitor and patches absolute node path in sidecar.json', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tokless-sidecar-'));
  try {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'install.js'), '--target', 'agy', '--copy'], {
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      stdio: 'pipe',
    });

    const sidecarJsonPath = path.join(
      tempHome,
      '.gemini',
      'config',
      'plugins',
      'agy-tokless',
      'sidecars',
      'tokless_monitor',
      'sidecar.json'
    );
    assert.ok(fs.existsSync(sidecarJsonPath), 'sidecar.json should be installed');
    const cfg = JSON.parse(fs.readFileSync(sidecarJsonPath, 'utf8'));
    assert.notEqual(cfg.command, 'node', 'sidecar.json command should use absolute node binary');
    assert.equal(cfg.ui_config.views[0].entrypoint, 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');

    const rulesPath = path.join(tempHome, '.gemini', 'config', 'plugins', 'agy-tokless', 'rules', 'AGENTS.md');
    const rulesText = fs.readFileSync(rulesPath, 'utf8');
    assert.ok(
      rulesText.includes('sidecar://agy-tokless/tokless_monitor/'),
      'rules/AGENTS.md should expose the one-click sidecar:// monitor pill'
    );
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('computeLiveSessionMetrics immediately drops context watermark when /compact CHECKPOINT lands in DB ahead of JSONL', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-compact-'));
  try {
    const convId = 'compact-test-session';
    const logsDir = path.join(tempHome, '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs');
    const convDbDir = path.join(tempHome, '.gemini', 'antigravity', 'conversations');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(convDbDir, { recursive: true });

    // JSONL 仅停留在压缩前的第 3 步（水位 215k）
    const jsonlLines = [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '你好' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', input_tokens: 20000, cache_read_tokens: 0, output_tokens: 300 }),
      JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: '继续分析大文件' }),
      JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', input_tokens: 5000, cache_read_tokens: 210000, output_tokens: 500 }),
    ];
    fs.writeFileSync(path.join(logsDir, 'transcript_full.jsonl'), jsonlLines.join('\n') + '\n', 'utf8');

    // SQLite DB 中已写入第 4 步 (/compact USER_INPUT, stepType=14) 和第 5 步 (CHECKPOINT, stepType=23, 摘要 3400 tok)
    let sqliteAvailable = false;
    try {
      const { DatabaseSync } = require('node:sqlite');
      sqliteAvailable = true;
      const db = new DatabaseSync(path.join(convDbDir, `${convId}.db`));
      db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
      const ins = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');

      const checkpointUsage = Buffer.concat([
        encodeVarintField(2, 215500), // 被压缩旧上下文
        encodeVarintField(3, 3450),   // 总输出
        encodeVarintField(9, 50),     // thinking
        encodeVarintField(10, 3400),  // 摘要正文
      ]);
      const checkpointMeta = Buffer.concat([
        encodeBytesField(1, encodeTimestamp(1795485793, 0)),
        encodeBytesField(7, encodeTimestamp(1795485831, 0)),
        encodeBytesField(9, checkpointUsage),
      ]);
      ins.run(4, 14, Buffer.alloc(0));
      ins.run(5, 23, checkpointMeta);
      db.close();
    } catch {
      // 旧版无 node:sqlite 时降级测 JSONL CHECKPOINT
      fs.appendFileSync(
        path.join(logsDir, 'transcript_full.jsonl'),
        [
          JSON.stringify({ step_index: 4, type: 'USER_INPUT', content: '/compact' }),
          JSON.stringify({ step_index: 5, type: 'CHECKPOINT', input_tokens: 215500, output_tokens: 3400 }),
        ].join('\n') + '\n',
        'utf8'
      );
    }

    const outRaw = execFileSync(
      process.execPath,
      [
        '-e',
        `const { computeLiveSessionMetrics } = require(${JSON.stringify(path.join(REPO_ROOT, 'tools', 'agy-audit', 'lib', 'live-metrics.js'))}); console.log(JSON.stringify(computeLiveSessionMetrics(${JSON.stringify(convId)})));`,
      ],
      { env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome }, encoding: 'utf8' }
    );
    const metrics = JSON.parse(outRaw.trim());
    assert.ok(metrics, `should return metrics (sqlite=${sqliteAvailable})`);
    assert.equal(metrics.currentTurn.isCompacted, true, 'current turn should be flagged as compacted');
    assert.ok(
      metrics.sessionTotal.currentContextTokens < 30000,
      `context watermark should drop from 215k to ~23.4k immediately, got ${metrics.sessionTotal.currentContextTokens}`
    );
    assert.ok(
      metrics.currentTurn.netDeltaTokens < -180000,
      `netDelta should reflect massive compaction reduction, got ${metrics.currentTurn.netDeltaTokens}`
    );
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
