'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'read-guard-hook.js');
const AUDIT_CLI = path.join(REPO_ROOT, 'tools', 'agy-audit', 'cli.js');
const { GUARDED_CODE_EXTS } = require(HOOK_SCRIPT);
const { auditProject } = require(path.join(REPO_ROOT, 'tools', 'agy-audit', 'lib', 'project.js'));

function runHook(payloadObj) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim());
}

function writeTranscript(baseDir, productDirName, convId, steps, mtimeSec) {
  const logsDir = path.join(
    baseDir,
    '.gemini',
    productDirName,
    'brain',
    convId,
    '.system_generated',
    'logs'
  );
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'transcript_full.jsonl');
  fs.writeFileSync(filePath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  if (mtimeSec !== undefined) {
    fs.utimesSync(filePath, mtimeSec, mtimeSec);
  }
  return filePath;
}

test('read-guard: guards C/C++ headers (.h/.hpp/.cc), allows ByteOffset, truncates huge skeletons, provides empty fallback', () => {
  for (const ext of ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx', '.inl', '.inc']) {
    assert.equal(GUARDED_CODE_EXTS.has(ext), true, `missing ${ext}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-guard-c-'));
  try {
    // 1. >800 行大头文件：拦截并限幅 120 条
    const headerLines = ['#ifndef BIG_DRV_H', '#define BIG_DRV_H'];
    for (let i = 0; i < 820; i++) {
      headerLines.push(`int drv_api_${i}(int arg);`);
    }
    headerLines.push('#endif');
    const bigH = path.join(tmpDir, 'big_drv.h');
    fs.writeFileSync(bigH, headerLines.join('\n') + '\n', 'utf8');

    const d1 = runHook({
      cwd: tmpDir,
      toolCall: { name: 'read_file', args: { Path: 'big_drv.h' } },
    });
    assert.equal(d1.decision, 'deny');
    assert.match(d1.reason, /已截断显示前 120 条/);

    // 2. ByteOffset 放行
    const d2 = runHook({
      toolCall: { name: 'read_file', args: { Path: bigH, ByteOffset: 1024 } },
    });
    assert.equal(d2.decision, 'allow');

    // 3. 纯注释 >800 行无符号文件：分段预览兜底
    const commentLines = Array.from({ length: 820 }, (_, i) => `// comment line ${i}`);
    const emptyHpp = path.join(tmpDir, 'comments.hpp');
    fs.writeFileSync(emptyHpp, commentLines.join('\n') + '\n', 'utf8');

    const d3 = runHook({
      toolCall: { name: 'view_file', args: { Path: emptyHpp } },
    });
    assert.equal(d3.decision, 'deny');
    assert.match(d3.reason, /\[L1-L400\]/);
    assert.match(d3.reason, /\[L401-L800\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('agy-audit CLI supports list, session latest, compare latest~1 latest, --source cli|app|ide, and --json anywhere', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-audit-cli-'));
  try {
    const cliConv1 = '11111111-aaaa-bbbb-cccc-000000000001';
    const ideConv2 = '22222222-aaaa-bbbb-cccc-000000000002';

    writeTranscript(
      fakeHome,
      'antigravity-cli',
      cliConv1,
      [
        {
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-22T09:00:00Z',
          content: '<USER_REQUEST>\nFix CAN timeout in MCAL\n</USER_REQUEST>',
        },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-22T09:00:05Z',
          input_tokens: 1000,
          cache_read_tokens: 500,
          output_tokens: 100,
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/can.c' } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          created_at: '2026-11-22T09:00:06Z',
          content: 'line\n'.repeat(200),
        },
      ],
      1700000100
    );

    writeTranscript(
      fakeHome,
      'antigravity-ide',
      ideConv2,
      [
        {
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-23T09:00:00Z',
          content: 'Verify ranged header read',
        },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-23T09:00:02Z',
          input_tokens: 300,
          cache_read_tokens: 200,
          output_tokens: 50,
          tool_calls: [{ name: 'read_file', args: { Path: '/tmp/can.h', ByteOffset: 256 } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          created_at: '2026-11-23T09:00:03Z',
          content: 'Showing lines 1-20 of 100',
        },
      ],
      1700000200
    );

    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };

    const listRes = spawnSync(
      process.execPath,
      [AUDIT_CLI, 'list', '--json', '--source', 'all'],
      { encoding: 'utf8', env }
    );
    assert.equal(listRes.status, 0, listRes.stderr);
    const listData = JSON.parse(listRes.stdout);
    assert.equal(listData.count, 2);
    assert.equal(listData.sessions[0].conversationId, ideConv2);
    assert.equal(listData.sessions[0].source, 'ide');
    assert.equal(listData.sessions[1].title, 'Fix CAN timeout in MCAL');

    const latestCliRes = spawnSync(
      process.execPath,
      [AUDIT_CLI, 'session', '--source', 'cli', '--json'],
      { encoding: 'utf8', env }
    );
    assert.equal(latestCliRes.status, 0, latestCliRes.stderr);
    const cliReport = JSON.parse(latestCliRes.stdout);
    assert.equal(cliReport.meta.conversationId, cliConv1);
    assert.equal(cliReport.meta.title, 'Fix CAN timeout in MCAL');
    assert.equal(cliReport.stats.blindReadCount, 1);

    const cmpRes = spawnSync(
      process.execPath,
      [AUDIT_CLI, 'compare', 'latest~1', 'latest', '--json'],
      { encoding: 'utf8', env }
    );
    assert.equal(cmpRes.status, 0, cmpRes.stderr);
    const cmpData = JSON.parse(cmpRes.stdout);
    assert.equal(cmpData.before.meta.conversationId, cliConv1);
    assert.equal(cmpData.after.meta.conversationId, ideConv2);
    assert.equal(cmpData.after.stats.blindReadCount, 0);
    assert.equal(cmpData.after.stats.rangedReadCount, 1);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('auditProject supports .agent/_agents/_agent dirs and model_decision trigger classification', () => {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-proj-multi-'));
  try {
    fs.writeFileSync(path.join(projDir, 'AGENTS.md'), '# Root\n');
    fs.mkdirSync(path.join(projDir, '.agent', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(projDir, '_agents', 'skills', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(projDir, '_agents', 'agents'), { recursive: true });

    fs.writeFileSync(
      path.join(projDir, '.agent', 'rules', 'on-demand.md'),
      '---\ntrigger: model_decision\n---\nOnly loaded when triggered.\n'
    );
    fs.writeFileSync(
      path.join(projDir, '_agents', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: demo\n---\n# Demo\n'
    );
    fs.writeFileSync(
      path.join(projDir, '_agents', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { demoMcp: { command: 'node' } } })
    );
    fs.writeFileSync(
      path.join(projDir, '_agents', 'agents', 'slim.md'),
      '---\nname: slim\ninheritMcp: false\ntools: [read_file]\n---\nSlim worker.\n'
    );

    const report = auditProject(projDir, { homeDir: projDir });
    assert.equal(report.summary.alwaysOn.count, 1);
    assert.equal(report.summary.progressiveDisclosure.count, 2);
    assert.equal(report.mcpAndToolTax.enabledMcpCount, 1);
    assert.equal(report.mcpAndToolTax.agents.length, 1);
    assert.equal(report.mcpAndToolTax.agents[0].name, 'slim');
    const onDemand = report.files.find((f) => f.relativePath === '.agent/rules/on-demand.md');
    assert.equal(onDemand.loadMode, 'Progressive Disclosure');
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test('agy-audit attributes Orchestrator dual-model switch cache cliffs and separates idle TTL expirations', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-model-switch-'));
  try {
    const transcriptPath = path.join(tmpDir, 'transcript_full.jsonl');
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-23T10:00:00Z', content: 'Orchestrator run' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T10:00:05Z',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 20000,
        cache_read_tokens: 0,
        output_tokens: 300
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T10:00:20Z',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 4000,
        cache_read_tokens: 20000,
        output_tokens: 200
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T10:00:40Z',
        model: 'gemini-flash-worker-agy',
        input_tokens: 24500,
        cache_read_tokens: 0,
        output_tokens: 250
      },
      {
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-23T12:05:40Z',
        model: 'gemini-pro-orchestrator-neon',
        input_tokens: 25500,
        cache_read_tokens: 0,
        output_tokens: 350
      }
    ];
    fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');

    const jsonRes = spawnSync(process.execPath, [AUDIT_CLI, 'session', transcriptPath, '--json'], { encoding: 'utf8' });
    assert.equal(jsonRes.status, 0, jsonRes.stderr);
    const report = JSON.parse(jsonRes.stdout);

    assert.equal(report.stats.distinctModelCount, 2);
    assert.equal(report.stats.modelSwitchCount, 2);
    assert.equal(report.modelBreakdown.length, 2);
    assert.equal(report.stats.cacheCliffCount, 2);
    assert.equal(report.stats.modelSwitchCacheCliffCount, 1);
    assert.equal(report.cacheCliffBreakdown.model_switch.count, 1);
    assert.equal(report.cacheCliffBreakdown.idle_ttl_expired.count, 1);

    const cliff1 = report.cacheCliffs[0];
    assert.equal(cliff1.reasonCode, 'model_switch');
    assert.equal(cliff1.isModelSwitch, true);
    assert.equal(cliff1.prevModel, 'gemini-pro-orchestrator-neon');
    assert.equal(cliff1.currModel, 'gemini-flash-worker-agy');
    assert.match(cliff1.reason, /双模型\/Orchestrator 自动切换/);

    const cliff2 = report.cacheCliffs[1];
    assert.equal(cliff2.reasonCode, 'idle_ttl_expired');
    assert.equal(cliff2.isModelSwitch, true);
    assert.match(cliff2.reason, /闲置超时/);
    assert.match(cliff2.reason, /切换模型/);

    const mdRes = spawnSync(process.execPath, [AUDIT_CLI, 'session', transcriptPath], { encoding: 'utf8' });
    assert.equal(mdRes.status, 0, mdRes.stderr);
    const md = mdRes.stdout;
    assert.match(md, /调用模型与切换次数/);
    assert.match(md, /断层根因拆解/);
    assert.match(md, /双模型\/Orchestrator 自动切换/);
    assert.match(md, /gemini-pro-orchestrator-neon/);
    assert.match(md, /gemini-flash-worker-agy/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('agy-audit estimates Pure-Lazy MCP tax with shared overhead, isolates unused tax, and finds distant DB blocks', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-lazy-mcp-'));
  try {
    const convA = 'aaaa1111-1111-2222-3333-000000000001';
    const convB = 'bbbb2222-1111-2222-3333-000000000002';
    const convC = 'cccc3333-1111-2222-3333-000000000003';
    const convDir = path.join(fakeHome, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const mcpHeader = [
      '<mcp_servers>',
      'Each MCP server has a directory `<appDataDir>\\mcp\\<serverName>` containing tool schemas (`<toolName>.json`) and optionally an `instructions.md` file with best practices.',
      'The following MCP servers and their available tools are listed below, following this format:',
      '```',
      '# <serverName>',
      'Eager:',
      '<toolName>',
      'Lazy:',
      '<toolName>',
      '```'
    ].join('\n');
    const bridgeDecls = 'Call a lazy-loaded MCP tool. Lists the available resources from an MCP server. Retrieves a specified resource.';

    // Case A: Pure-Lazy single unused MCP, with first Conversation ID >120KB away from <mcp_servers>
    writeTranscript(
      fakeHome,
      'antigravity-cli',
      convA,
      [
        { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z', content: 'Pure lazy MCP test' },
        { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-24T10:00:05Z', input_tokens: 12000, cache_read_tokens: 0, output_tokens: 200 },
        { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-24T10:00:15Z', input_tokens: 500, cache_read_tokens: 12000, output_tokens: 200 }
      ],
      1700000300
    );
    const dbAContent = [
      `Conversation ID: ${convA}`,
      'Call a lazy-loaded MCP tool.',
      'X'.repeat(2200000),
      'Lists the available resources from an MCP server. Retrieves a specified resource.',
      `${mcpHeader}\n# gemini-web-mcp\nLazy:\ngemini_ask\ngemini_sessions\ngemini_health\n</mcp_servers>`,
      'Y'.repeat(2000),
      `Conversation ID: ${convA}`
    ].join('\n');
    fs.writeFileSync(path.join(convDir, `${convA}.db`), dbAContent, 'utf8');

    // Case B: 1 invoked Eager MCP + 1 unused Pure-Lazy MCP (shared overhead must NOT be charged to unused)
    writeTranscript(
      fakeHome,
      'antigravity-cli',
      convB,
      [
        { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T11:00:00Z', content: 'Mixed invoked and unused MCP' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-24T11:00:05Z',
          input_tokens: 15000,
          cache_read_tokens: 0,
          output_tokens: 200,
          tool_calls: [{ name: 'mcp_chrome-devtools_list_pages', args: {} }]
        },
        { step_index: 2, type: 'GENERIC', created_at: '2026-11-24T11:00:06Z', content: 'Pages: []' }
      ],
      1700000400
    );
    const dbBContent = [
      bridgeDecls,
      `${mcpHeader}\n# chrome-devtools\nEager:\nlist_pages\nclick\n# gemini-web-mcp\nLazy:\ngemini_ask\ngemini_sessions\ngemini_health\n</mcp_servers>`,
      `Conversation ID: ${convB}`
    ].join('\n');
    fs.writeFileSync(path.join(convDir, `${convB}.db`), dbBContent, 'utf8');

    // Case C: MCP schema file read counts as invoked (not unused)
    writeTranscript(
      fakeHome,
      'antigravity-cli',
      convC,
      [
        { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T12:00:00Z', content: 'Schema read test' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-24T12:00:05Z',
          input_tokens: 12000,
          cache_read_tokens: 0,
          output_tokens: 100,
          tool_calls: [{ name: 'read_file', args: { Path: '/home/u/.gemini/antigravity-cli/mcp/gemini-web-mcp/gemini_ask.json', StartLine: 1, EndLine: 50 } }]
        },
        { step_index: 2, type: 'GENERIC', created_at: '2026-11-24T12:00:06Z', content: '{}' }
      ],
      1700000500
    );
    const dbCContent = [
      bridgeDecls,
      `${mcpHeader}\n# gemini-web-mcp\nLazy:\ngemini_ask\ngemini_sessions\ngemini_health\n</mcp_servers>`,
      `Conversation ID: ${convC}`
    ].join('\n');
    fs.writeFileSync(path.join(convDir, `${convC}.db`), dbCContent, 'utf8');

    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome };

    const resA = spawnSync(process.execPath, [AUDIT_CLI, 'session', convA, '--source', 'cli', '--json'], { encoding: 'utf8', env });
    assert.equal(resA.status, 0, resA.stderr);
    const repA = JSON.parse(resA.stdout);
    assert.equal(repA.mcpAudit.mountedCount, 1);
    assert.equal(repA.mcpAudit.servers[0].loadingMode, 'lazy');
    assert.equal(repA.mcpAudit.servers[0].estimateBasis, 'prompt_index');
    assert.equal(repA.mcpAudit.servers[0].estTokensPerStep, 24);
    assert.ok(repA.mcpAudit.sharedOverheadEstTokensPerStep >= 300, 'should account for preamble + 3 bridge tools');
    assert.equal(repA.mcpAudit.unusedServersEstTokensPerStep, 24);
    assert.equal(repA.mcpAudit.unusedSharedOverheadPerStep, repA.mcpAudit.sharedOverheadEstTokensPerStep);
    assert.equal(repA.mcpAudit.unusedEstTokensPerStep, 24 + repA.mcpAudit.sharedOverheadEstTokensPerStep);
    assert.equal(repA.mcpAudit.unusedLazyOnly, true);

    const mdA = spawnSync(process.execPath, [AUDIT_CLI, 'session', convA, '--source', 'cli'], { encoding: 'utf8', env }).stdout;
    assert.match(mdA, /轻量 Lazy 挂载提示/);
    assert.doesNotMatch(mdA, /空载继承告警/);
    assert.match(mdA, /0 \/ 3 \(Lazy\)/);

    const resB = spawnSync(process.execPath, [AUDIT_CLI, 'session', convB, '--source', 'cli', '--json'], { encoding: 'utf8', env });
    assert.equal(resB.status, 0, resB.stderr);
    const repB = JSON.parse(resB.stdout);
    assert.equal(repB.mcpAudit.mountedCount, 2);
    assert.deepEqual(repB.mcpAudit.unusedServerNames, ['gemini-web-mcp']);
    assert.equal(repB.mcpAudit.unusedSharedOverheadPerStep, 0, 'shared overhead must not be charged when another MCP is invoked');
    assert.equal(repB.mcpAudit.unusedEstTokensPerStep, 24);
    assert.equal(repB.mcpAudit.unusedEstSessionTaxTokens, 24);

    const resC = spawnSync(process.execPath, [AUDIT_CLI, 'session', convC, '--source', 'cli', '--json'], { encoding: 'utf8', env });
    assert.equal(resC.status, 0, resC.stderr);
    const repC = JSON.parse(resC.stdout);
    assert.deepEqual(repC.mcpAudit.unusedServerNames, []);
    assert.equal(repC.mcpAudit.servers[0].callCount, 1);
    assert.equal(repC.mcpAudit.unusedEstSessionTaxTokens, 0);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('agy-audit classifies 300s-2999s low-retention cache cliffs as short_idle_cache_evicted with boundary checks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-short-ttl-'));
  try {
    const transcriptPath = path.join(tmpDir, 'transcript_full.jsonl');
    const baseMs = Date.parse('2026-11-24T10:00:00Z');
    const at = (sec) => new Date(baseMs + sec * 1000).toISOString();
    let t = 0;
    const steps = [
      { step_index: 0, type: 'USER_INPUT', created_at: at(t), content: 'Short TTL boundary test' },
      // Warmup
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: at((t += 5)), model: 'm-a', input_tokens: 20000, cache_read_tokens: 0, output_tokens: 100 },
      { step_index: 2, type: 'PLANNER_RESPONSE', created_at: at((t += 10)), model: 'm-a', input_tokens: 2000, cache_read_tokens: 20000, output_tokens: 100 },
      // 1) 299s (<300s) -> prefix_mutated_or_evicted
      { step_index: 3, type: 'PLANNER_RESPONSE', created_at: at((t += 299)), model: 'm-a', input_tokens: 23000, cache_read_tokens: 0, output_tokens: 100 },
      // 2) 300s (=300s, 0% retention) -> short_idle_cache_evicted
      { step_index: 4, type: 'PLANNER_RESPONSE', created_at: at((t += 300)), model: 'm-a', input_tokens: 24000, cache_read_tokens: 0, output_tokens: 100 },
      // 3) 420s but 25% retention (>15%) -> prefix_mutated_or_evicted with interval hint
      { step_index: 5, type: 'PLANNER_RESPONSE', created_at: at((t += 420)), model: 'm-a', input_tokens: 19000, cache_read_tokens: 6000, output_tokens: 100 },
      // 4) 420s, same known model + USER_SETTINGS_CHANGE + 0% -> short_idle_cache_evicted (non-model setting does not mask 7m TTL)
      { step_index: 6, type: 'USER_SETTINGS_CHANGE', created_at: at(t + 10), content: 'theme changed' },
      { step_index: 7, type: 'PLANNER_RESPONSE', created_at: at((t += 420)), model: 'm-a', input_tokens: 26000, cache_read_tokens: 0, output_tokens: 100 },
      // 5) 420s + model switch -> model_switch (with interval hint)
      { step_index: 8, type: 'PLANNER_RESPONSE', created_at: at((t += 420)), model: 'm-b', input_tokens: 27000, cache_read_tokens: 0, output_tokens: 100 },
      // 6) 2999s (<3000s, 0% retention) -> short_idle_cache_evicted
      { step_index: 9, type: 'PLANNER_RESPONSE', created_at: at((t += 2999)), model: 'm-b', input_tokens: 28000, cache_read_tokens: 0, output_tokens: 100 },
      // 7) 3000s (=3000s, 0% retention) -> idle_ttl_expired
      { step_index: 10, type: 'PLANNER_RESPONSE', created_at: at((t += 3000)), model: 'm-b', input_tokens: 29000, cache_read_tokens: 0, output_tokens: 100 }
    ];
    fs.writeFileSync(transcriptPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');

    const res = spawnSync(process.execPath, [AUDIT_CLI, 'session', transcriptPath, '--json'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);

    assert.deepEqual(
      report.cacheCliffs.map((c) => c.reasonCode),
      [
        'prefix_mutated_or_evicted',
        'short_idle_cache_evicted',
        'prefix_mutated_or_evicted',
        'short_idle_cache_evicted',
        'model_switch',
        'short_idle_cache_evicted',
        'idle_ttl_expired'
      ]
    );
    assert.equal(report.stats.shortIdleCacheCliffCount, 3);
    assert.equal(report.cacheCliffBreakdown.short_idle_cache_evicted.count, 3);
    assert.ok(report.stats.shortIdleCacheRebilledTokens > 0);
    assert.match(report.cacheCliffs[1].reason, /疑似短窗口缓存过期/);
    assert.match(report.cacheCliffs[2].reason, /7\.0 分钟/);
    assert.match(report.cacheCliffs[3].reason, /非模型设置变更/);
    assert.match(report.cacheCliffs[4].reason, /7\.0 分钟/);

    const md = spawnSync(process.execPath, [AUDIT_CLI, 'session', transcriptPath], { encoding: 'utf8' }).stdout;
    assert.match(md, /短窗口缓存过期\(5~50m\)/);

    const cmpRes = spawnSync(process.execPath, [AUDIT_CLI, 'compare', transcriptPath, transcriptPath, '--json'], { encoding: 'utf8' });
    assert.equal(cmpRes.status, 0, cmpRes.stderr);
    const cmp = JSON.parse(cmpRes.stdout);
    assert.equal(cmp.metrics.shortIdleCacheCliffCount.before, 3);
    assert.equal(cmp.metrics.shortIdleCacheRebilledTokens.before, report.stats.shortIdleCacheRebilledTokens);
    assert.equal(cmp.metrics.mcpUnusedEstSessionTaxTokens.before, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
