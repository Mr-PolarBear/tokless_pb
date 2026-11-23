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
