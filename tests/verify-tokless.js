#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function testZeroPersonalPathLeak() {
  const username = os.userInfo().username;
  const forbiddenPatterns = [
    new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    /[A-Za-z]:\\Users\\/i,
    /\/Users\/[A-Za-z0-9._-]+/,
    /[A-Za-z]:\\code\\/i,
  ];

  const localDenylistPath = path.join(REPO_ROOT, '.tokless-private-denylist');
  if (fs.existsSync(localDenylistPath)) {
    const terms = fs
      .readFileSync(localDenylistPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    for (const term of terms) {
      forbiddenPatterns.push(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  }

  const files = walkFiles(REPO_ROOT);
  const violations = [];
  for (const file of files) {
    if (file.endsWith('.zip') || file.endsWith('.png') || file.endsWith('.jpg')) continue;
    const rel = path.relative(REPO_ROOT, file);
    const normalizedRel = rel.replace(/\\/g, '/');
    if (
      normalizedRel === 'tests/verify-tokless.js' ||
      normalizedRel === '.tokless-private-denylist' ||
      normalizedRel === 'AGENTS.local.md' ||
      normalizedRel.endsWith('.local.md')
    ) {
      continue;
    }
    const content = fs.readFileSync(file, 'utf8');
    for (const re of forbiddenPatterns) {
      const m = content.match(re);
      if (m) {
        violations.push(`${rel}: matched "${m[0]}"`);
      }
    }
  }
  assert.strictEqual(
    violations.length,
    0,
    `Personal username or local machine path leaked in repository:\n${violations.join('\n')}`
  );
  const packOut = execSync('npm pack --dry-run --json', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const packedPaths = (JSON.parse(packOut.slice(packOut.indexOf('[')))[0]?.files || []).map((f) => f.path);
  assert(packedPaths.length > 0 && !packedPaths.some((p) => p === 'AGENTS.local.md' || p.endsWith('.local.md') || p === '.tokless-private-denylist'));
  console.log('  [PASS] 1. Zero personal username or local machine path leaks across repository');
}

function testAgyAuditCacheCliffsAndMcpTax(tmpDir) {
  const auditCli = path.join(REPO_ROOT, 'tools', 'agy-audit', 'cli.js');

  const transcriptPath = path.join(tmpDir, 'transcript_full.jsonl');
  const syntheticSteps = [
    { step_index: 1, type: 'USER_INPUT', created_at: '2026-05-01T10:00:00Z', content: 'start' },
    { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T10:00:05Z', input_tokens: 18000, cache_read_tokens: 0, output_tokens: 400 },
    { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T10:00:20Z', input_tokens: 4000, cache_read_tokens: 18000, output_tokens: 300 },
    { step_index: 4, type: 'USER_INPUT', created_at: '2026-05-01T11:10:20Z', content: 'resume after lunch' },
    { step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T11:10:25Z', input_tokens: 23500, cache_read_tokens: 0, output_tokens: 500 },
    { step_index: 6, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T11:10:40Z', input_tokens: 2500, cache_read_tokens: 23500, output_tokens: 200 },
    { step_index: 7, type: 'USER_SETTINGS_CHANGE', created_at: '2026-05-01T11:11:00Z', content: 'model switched' },
    { step_index: 8, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T11:11:05Z', input_tokens: 27000, cache_read_tokens: 0, output_tokens: 350 },
    { step_index: 9, type: 'CHECKPOINT', created_at: '2026-05-01T11:12:00Z', content: '# Resuming from a compaction\nSummary...' },
    { step_index: 10, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T11:12:05Z', input_tokens: 16000, cache_read_tokens: 0, output_tokens: 300 },
    { step_index: 11, type: 'PLANNER_RESPONSE', created_at: '2026-05-01T11:12:15Z', input_tokens: 14000, cache_read_tokens: 16000, output_tokens: 300 },
    {
      step_index: 12,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-05-01T11:12:25Z',
      input_tokens: 28000,
      cache_read_tokens: 4000,
      output_tokens: 300,
      tool_calls: [
        { name: 'read_file', args: { Path: '/tmp/demo/large.js', StartLine: 1, EndLine: 400 } },
        { name: 'call_mcp_tool', args: { ServerName: 'chrome-devtools', ToolName: 'list_pages', Arguments: {} } }
      ]
    },
    {
      step_index: 13,
      type: 'GENERIC',
      created_at: '2026-05-01T11:12:37Z',
      content: 'Created At: 2026-05-01T11:12:26Z\nCompleted At: 2026-05-01T11:12:37Z\nShowing lines 1-400 of 600\nconst x = 1;'
    },
    {
      step_index: 14,
      type: 'GENERIC',
      created_at: '2026-05-01T11:12:40Z',
      content: 'Created At: 2026-05-01T11:12:38Z\nCompleted At: 2026-05-01T11:12:40Z\nPages: []'
    }
  ];
  fs.writeFileSync(transcriptPath, syntheticSteps.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');

  const sessionJsonRaw = execFileSync(process.execPath, [auditCli, 'session', transcriptPath, '--json'], {
    encoding: 'utf8'
  });
  const sessionReport = JSON.parse(sessionJsonRaw);
  assert.strictEqual(sessionReport.stats.compactionCount, 1, 'Should detect 1 CHECKPOINT compaction');
  assert.strictEqual(sessionReport.stats.cacheCliffCount, 3, 'Should detect exact 3 non-compaction Prefix Cache cliffs');
  assert.strictEqual(sessionReport.cacheCliffs[0].reasonCode, 'idle_ttl_expired');
  assert.strictEqual(sessionReport.cacheCliffs[1].reasonCode, 'settings_or_model_switch');
  assert.strictEqual(sessionReport.cacheCliffs[2].reasonCode, 'prefix_mutated_or_evicted');
  assert.strictEqual(sessionReport.stats.readTotalCount, 1);
  assert.strictEqual(sessionReport.stats.rangedReadCount, 1);
  assert.strictEqual(sessionReport.stats.blindReadCount, 0);
  assert.strictEqual(sessionReport.stats.readWideSpanCount, undefined, 'Ranged reads >300 lines must NOT be flagged as wide-span violations');
  assert.strictEqual(sessionReport.stats.compactionThresholdGen4EstTokens, 512000);
  assert.strictEqual(sessionReport.mcpAudit.mountedCount, 1, 'Should detect invoked external MCP server');
  assert(sessionReport.mcpAudit.prefixes.includes('mcp_chrome-devtools_'));
  assert(Array.isArray(sessionReport.slowestSteps) && sessionReport.slowestSteps.length === 2);
  assert(sessionReport.slowestSteps[0].durationSec >= 11);
  assert(Array.isArray(sessionReport.turnDeltas) && sessionReport.turnDeltas.length === 2);

  const sessionMd = execFileSync(process.execPath, [auditCli, 'session', transcriptPath], { encoding: 'utf8' });
  assert(sessionMd.includes('Prefix Cache 命中率与断层诊断'));
  assert(sessionMd.includes('闲置超时导致缓存过期'));
  assert(sessionMd.includes('440K'));
  assert(sessionMd.includes('512K'));
  assert(!sessionMd.includes('大跨度读取'));

  const fakeHome = path.join(tmpDir, 'fake-home');
  const fakeMcpDir = path.join(fakeHome, '.gemini', 'config');
  fs.mkdirSync(fakeMcpDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeMcpDir, 'mcp_config.json'),
    JSON.stringify({
      mcpServers: {
        'chrome-devtools': {
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp'],
          env: { SUPER_SECRET_TOKEN: 'DO_NOT_LEAK_12345' }
        },
        'disabled-db': {
          command: 'sqlite-mcp',
          disabled: true
        }
      }
    }),
    'utf8'
  );

  const sampleProj = path.join(tmpDir, 'sample-proj');
  fs.mkdirSync(path.join(sampleProj, '.agents', 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(sampleProj, '.agents', 'agents', 'fast-worker.md'),
    [
      '---',
      'name: fast-worker',
      'description: Lean worker',
      'mainAgent: true',
      'inheritMcp: false',
      'tools: [read_file, edit_file, run_command]',
      '---',
      'Work fast.'
    ].join('\n'),
    'utf8'
  );

  const projJsonRaw = execFileSync(
    process.execPath,
    [auditCli, 'project', sampleProj, '--home', fakeHome, '--json'],
    { encoding: 'utf8' }
  );
  assert(!projJsonRaw.includes('DO_NOT_LEAK_12345'), 'Must NEVER leak MCP env secret values');
  const projReport = JSON.parse(projJsonRaw);
  assert.strictEqual(projReport.mcpAndToolTax.totalMcpCount, 2);
  assert.strictEqual(projReport.mcpAndToolTax.enabledMcpCount, 1);
  assert.strictEqual(projReport.mcpAndToolTax.activeMcpEstTokensPerStep, 3000);
  assert.strictEqual(projReport.mcpAndToolTax.agents.length, 1);
  assert.strictEqual(projReport.mcpAndToolTax.agents[0].inheritMcp, false);
  assert.strictEqual(projReport.mcpAndToolTax.agents[0].mcpEstTokens, 0);
  assert(projReport.mcpAndToolTax.agents[0].savedPerStepTokens > 5000);

  const selfAuditRaw = execFileSync(
    process.execPath,
    [auditCli, 'project', REPO_ROOT, '--home', fakeHome, '--json'],
    { encoding: 'utf8' }
  );
  const selfAudit = JSON.parse(selfAuditRaw);
  assert(selfAudit.summary.alwaysOn.count >= 2, 'Both root AGENTS.md and rules/AGENTS.md must be discovered');
  assert(typeof selfAudit.summary.alwaysOn.est30StepTokens === 'number', '30-step snowball token estimate must be exposed');
  assert.strictEqual(selfAudit.summary.progressiveDisclosure.count, 2, 'Both code-skeleton and token-audit SKILL.md must exist');
  assert.strictEqual(selfAudit.mcpAndToolTax.agents.length, 2, 'Exactly 2 official lightweight agent templates (coder + reviewer) must be discovered');

  const rootPkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const rootPluginJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  assert.strictEqual(
    Object.keys(rootPkgJson.dependencies || {}).length,
    0,
    'package.json must maintain zero runtime dependencies'
  );
  assert.strictEqual(
    rootPkgJson.version,
    rootPluginJson.version,
    `Version mismatch: package.json (${rootPkgJson.version}) !== plugin.json (${rootPluginJson.version}). Run: npm run bump -- <version>`
  );

  console.log('  [PASS] 2. agy-audit session Prefix Cache cliffs, Gen3/Gen4 compaction context & MCP/tool base tax');
}

function testRepoSkeletonAndReadGuardHook(tmpDir) {
  const skelCli = path.join(REPO_ROOT, 'tools', 'repo-skeleton', 'cli.js');
  const out = execFileSync(process.execPath, [skelCli, REPO_ROOT, '--depth', '3'], { encoding: 'utf8' });
  assert(out.includes('read-guard-hook.js'));
  assert(out.includes('function evaluateReadGuard'));
  assert(out.includes(' 字 | '));

  const mapOut = execFileSync(process.execPath, [skelCli, REPO_ROOT, '--map'], { encoding: 'utf8' });
  assert(mapOut.includes('目录地图:'));
  assert(mapOut.includes('tools/repo-skeleton/lib/skeleton.js ('));
  assert(!mapOut.includes('function evaluateReadGuard'), '--map mode must not expand internal AST signatures');

  const mapShallowOut = execFileSync(process.execPath, [skelCli, REPO_ROOT, '--map', '--depth', '1'], { encoding: 'utf8' });
  assert(mapShallowOut.includes('index.js ('));
  assert(!mapShallowOut.includes('tools/repo-skeleton/lib/skeleton.js ('), '--map with --depth 1 must respect explicit depth');

  const mapJsonRaw = execFileSync(process.execPath, [skelCli, REPO_ROOT, '--map', '--json'], { encoding: 'utf8' });
  const mapJson = JSON.parse(mapJsonRaw);
  assert.strictEqual(mapJson.mode, 'map');
  assert.strictEqual(mapJson.depth, 8);
  assert(typeof mapJson.totalChars === 'number' && mapJson.totalChars > 1000);
  assert(Array.isArray(mapJson.files) && mapJson.files.some((f) => f.relPath === 'tools/repo-skeleton/lib/skeleton.js' && f.charCount > 1000));

  const cliHelpOut = execFileSync(process.execPath, [skelCli, '--help'], { encoding: 'utf8' });
  assert(cliHelpOut.includes('--map'));

  const hookScript = path.join(REPO_ROOT, 'scripts', 'read-guard-hook.js');
  const mediumJs = path.join(tmpDir, 'medium-750.js');
  const mediumLines = [];
  for (let i = 1; i <= 750; i++) {
    mediumLines.push(i === 10 ? 'function withinLimit() { return 1; }' : `const m${i} = ${i};`);
  }
  fs.writeFileSync(mediumJs, mediumLines.join('\n'), 'utf8');

  const bigJs = path.join(tmpDir, 'big.js');
  const bigLines = [];
  for (let i = 1; i <= 900; i++) {
    bigLines.push(i === 10 ? 'function alpha() { return 1; }' : `const v${i} = ${i};`);
  }
  fs.writeFileSync(bigJs, bigLines.join('\n'), 'utf8');

  // 0) Blind read of <=800-line file MUST allow by default
  const mediumBlindRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: mediumJs } } }),
      encoding: 'utf8'
    }
  );
  assert.strictEqual(JSON.parse(mediumBlindRes.stdout.trim()).decision, 'allow');

  // 1) Unsliced blind read of >800-line file MUST deny with skeleton navigation
  const blindRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: bigJs } } }),
      encoding: 'utf8'
    }
  );
  const blindJson = JSON.parse(blindRes.stdout.trim());
  assert.strictEqual(blindJson.decision, 'deny');
  assert(blindJson.reason.includes('function alpha()'));

  // 2) Ranged read of 450 lines (e.g. L20-L470) MUST 100% allow
  const ranged450Res = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: bigJs, StartLine: 20, EndLine: 470 } } }),
      encoding: 'utf8'
    }
  );
  const ranged450Json = JSON.parse(ranged450Res.stdout.trim());
  assert.strictEqual(ranged450Json.decision, 'allow');

  // 3) Explicit full-file line range (e.g. L1-L900 on a 900-line file) MUST 100% allow (fake-slice block abolished!)
  const explicitFullRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: bigJs, StartLine: 1, EndLine: 900 } } }),
      encoding: 'utf8'
    }
  );
  assert.strictEqual(JSON.parse(explicitFullRes.stdout.trim()).decision, 'allow');

  // 4) Single-sided line parameter (StartLine only or EndLine only) MUST also allow
  const startOnlyRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: bigJs, StartLine: 1 } } }),
      encoding: 'utf8'
    }
  );
  assert.strictEqual(JSON.parse(startOnlyRes.stdout.trim()).decision, 'allow');

  // 5) Claude Code `Read` PreToolUse hook compatibility (deny >800 unsliced blind read + allow any explicit offset/limit including L1-L900)
  const claudeBlindRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: bigJs }
      }),
      encoding: 'utf8'
    }
  );
  const claudeBlindJson = JSON.parse(claudeBlindRes.stdout.trim());
  assert(claudeBlindJson.hookSpecificOutput, 'Claude Code deny must return hookSpecificOutput');
  assert.strictEqual(claudeBlindJson.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(claudeBlindJson.hookSpecificOutput.permissionDecision, 'deny');
  assert(claudeBlindJson.hookSpecificOutput.permissionDecisionReason.includes('function alpha()'));

  const claudeAllowRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: bigJs, offset: 15, limit: 450 }
      }),
      encoding: 'utf8'
    }
  );
  const claudeAllowJson = JSON.parse(claudeAllowRes.stdout.trim());
  assert.deepStrictEqual(claudeAllowJson, {});

  const claudeExplicitFullRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: bigJs, offset: 1, limit: 900 }
      }),
      encoding: 'utf8'
    }
  );
  assert.deepStrictEqual(JSON.parse(claudeExplicitFullRes.stdout.trim()), {});

  // 6) TOKLESS_READ_MAX_LINES env priority over AGY_READ_MAX_LINES
  const envOverrideRes = spawnSync(
    process.execPath,
    [hookScript],
    {
      env: { ...process.env, TOKLESS_READ_MAX_LINES: '1000', AGY_READ_MAX_LINES: '100' },
      input: JSON.stringify({ toolCall: { name: 'read_file', args: { Path: bigJs } } }),
      encoding: 'utf8'
    }
  );
  assert.strictEqual(JSON.parse(envOverrideRes.stdout.trim()).decision, 'allow');

  console.log('  [PASS] 3. repo-skeleton & PreToolUse read-guard-hook (800-line default, explicit line range 100% allow)');
}

function testProgrammaticPackageExports(tmpDir) {
  const consumerDir = path.join(tmpDir, 'consumer-app');
  const nmScopeDir = path.join(consumerDir, 'node_modules');
  fs.mkdirSync(nmScopeDir, { recursive: true });
  const pkgLinkPath = path.join(nmScopeDir, 'tokless');
  fs.symlinkSync(REPO_ROOT, pkgLinkPath, process.platform === 'win32' ? 'junction' : 'dir');

  const consumerScript = path.join(consumerDir, 'check-exports.js');
  const bigJs = path.join(tmpDir, 'export-guard-big.js');
  const bigLines = [];
  for (let i = 1; i <= 860; i++) {
    bigLines.push(i === 15 ? 'function exportedAlpha(x) { return x + 1; }' : `const item${i} = ${i};`);
  }
  fs.writeFileSync(bigJs, bigLines.join('\n'), 'utf8');

  const sessionJsonl = path.join(tmpDir, 'export-session.jsonl');
  fs.writeFileSync(
    sessionJsonl,
    [
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        created_at: '2026-06-01T10:00:00Z',
        content: 'Check exports'
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-06-01T10:00:02Z',
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_tokens: 1000
      })
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    consumerScript,
    `'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const rootPkg = require('tokless');
const skelMod = require('tokless/skeleton');
const auditMod = require('tokless/audit');
const guardMod = require('tokless/read-guard');
const pkgJson = require('tokless/package.json');

assert.strictEqual(pkgJson.name, 'tokless');
assert.strictEqual(pkgJson.version, ${JSON.stringify(EXPECTED_VERSION)});
assert.strictEqual(typeof rootPkg.scanFileLightweight, 'function');
assert(pkgJson.bin && pkgJson.bin.tokless && pkgJson.bin['repo-skeleton'] && pkgJson.bin['agy-audit']);
assert.deepStrictEqual(Object.keys(pkgJson.bin).sort(), ['agy-audit', 'repo-skeleton', 'tokless']);
assert(pkgJson.exports['.'] && pkgJson.exports['./skeleton']);
assert(pkgJson.exports['./audit'] && pkgJson.exports['./read-guard'] && pkgJson.exports['./package.json']);
assert.deepStrictEqual(Object.keys(pkgJson.exports).sort(), ['.', './audit', './package.json', './read-guard', './skeleton']);

assert.strictEqual(rootPkg.generateFileSkeleton, skelMod.generateFileSkeleton);
assert.strictEqual(rootPkg.scanDirectorySkeleton, skelMod.scanDirectorySkeleton);
assert.strictEqual(rootPkg.generateRepoMap, skelMod.generateRepoMap);
assert.strictEqual(rootPkg.formatDirectoryMap, skelMod.formatDirectoryMap);
assert.strictEqual(rootPkg.sliceSymbol, skelMod.sliceSymbol);
assert.strictEqual(rootPkg.locateSymbol, skelMod.locateSymbol);
assert.strictEqual(typeof rootPkg.sliceSymbol, 'function');
assert.strictEqual(typeof rootPkg.locateSymbol, 'function');
assert.strictEqual(typeof skelMod.sliceSymbol, 'function');
assert.strictEqual(typeof skelMod.generateSkeleton, 'function');
assert.strictEqual(typeof skelMod.formatDirectorySkeleton, 'function');
assert.strictEqual(typeof skelMod.generateRepoMap, 'function');
assert.strictEqual(typeof skelMod.formatDirectoryMap, 'function');

const slicedAlpha = rootPkg.sliceSymbol(${JSON.stringify(bigJs)}, 'exportedAlpha');
assert.strictEqual(slicedAlpha.mode, 'slice');
assert.strictEqual(slicedAlpha.found, true);
assert.strictEqual(slicedAlpha.matchCount, 1);
assert.strictEqual(slicedAlpha.matches[0].startLine, 15);
assert.strictEqual(slicedAlpha.matches[0].endLine, 15);
assert(slicedAlpha.matches[0].content.includes('function exportedAlpha(x) { return x + 1; }'));

const fileSkel = skelMod.generateFileSkeleton(${JSON.stringify(bigJs)}, { includeHeader: true });
assert.strictEqual(fileSkel.totalLines, 860);
assert.strictEqual(fileSkel.lineCount, 860);
assert.strictEqual(fileSkel.charCount, fs.readFileSync(${JSON.stringify(bigJs)}, 'utf8').length);
assert(fileSkel.formatted.includes('function exportedAlpha(x)'));
assert(fileSkel.formatted.includes(' 字 | '));

const unifiedFile = skelMod.generateSkeleton(${JSON.stringify(bigJs)});
assert.strictEqual(unifiedFile.mode, 'file');
assert.strictEqual(unifiedFile.charCount, fileSkel.charCount);
assert(unifiedFile.text.includes(' 字 | '));
assert(unifiedFile.text.includes('function exportedAlpha(x)'));

const unifiedDir = skelMod.generateSkeleton(${JSON.stringify(tmpDir)}, { depth: 1 });
assert.strictEqual(unifiedDir.mode, 'directory');
assert(typeof unifiedDir.totalChars === 'number' && unifiedDir.totalChars >= fileSkel.charCount);
assert(unifiedDir.text.includes('export-guard-big.js'));
assert(unifiedDir.text.includes(' 字 | '));

const repoMap = rootPkg.generateRepoMap(${JSON.stringify(tmpDir)});
assert.strictEqual(repoMap.mode, 'map');
assert.strictEqual(repoMap.map, true);
assert(repoMap.text.includes('export-guard-big.js (860 行 | '));
assert(!repoMap.text.includes('function exportedAlpha(x)'));

const mapViaSkel = skelMod.generateSkeleton(${JSON.stringify(tmpDir)}, { map: true });
assert.strictEqual(mapViaSkel.mode, 'map');
assert.strictEqual(mapViaSkel.totalChars, repoMap.totalChars);

assert.strictEqual(rootPkg.analyzeSession, auditMod.analyzeSession);
assert.strictEqual(rootPkg.auditProject, auditMod.auditProject);
assert.strictEqual(rootPkg.compareSessions, auditMod.compareSessions);
const sessionRep = auditMod.analyzeSession(${JSON.stringify(sessionJsonl)});
assert.strictEqual(sessionRep.stats.totalSteps, 2);
assert.strictEqual(sessionRep.stats.totalInputTokens, 1200);
const projRep = auditMod.auditProject(${JSON.stringify(tmpDir)}, { homeDir: ${JSON.stringify(tmpDir)} });
assert(typeof projRep.summary.alwaysOn.estTokens === 'number');

assert.strictEqual(rootPkg.evaluateReadGuard, guardMod.evaluateReadGuard);
assert.strictEqual(guardMod.checkReadGuard, guardMod.evaluateReadGuard);
assert.strictEqual(typeof guardMod.buildClaudePreToolUseHookConfig, 'function');
assert(fs.existsSync(guardMod.READ_GUARD_SCRIPT_PATH));
assert(fs.existsSync(guardMod.scriptPath));
assert(fs.existsSync(guardMod.HOOKS_CONFIG_PATH));

const denyVerdict = guardMod.evaluateReadGuard({
  toolCall: { name: 'read_file', args: { Path: ${JSON.stringify(bigJs)} } }
});
assert.strictEqual(denyVerdict.decision, 'deny');
assert(denyVerdict.reason.includes('function exportedAlpha(x)'));

const allow450Verdict = guardMod.evaluateReadGuard({
  toolCall: { name: 'read_file', args: { Path: ${JSON.stringify(bigJs)}, StartLine: 10, EndLine: 460 } }
});
assert.strictEqual(allow450Verdict.decision, 'allow');

const allowExplicitFullVerdict = guardMod.evaluateReadGuard({
  toolCall: { name: 'read_file', args: { Path: ${JSON.stringify(bigJs)}, StartLine: 1, EndLine: 860 } }
});
assert.strictEqual(allowExplicitFullVerdict.decision, 'allow');

const claudeCfg = guardMod.buildClaudePreToolUseHookConfig();
assert(Array.isArray(claudeCfg.PreToolUse) && claudeCfg.PreToolUse[0].matcher === 'Read');

const hookCfg = guardMod.buildPreToolUseHookConfig();
assert(hookCfg['read-file-guard'] && Array.isArray(hookCfg['read-file-guard'].PreToolUse));

const fakeHome = path.join(${JSON.stringify(tmpDir)}, 'fake-home');
assert.strictEqual(rootPkg.detectGlobalPlugin({ homeDir: fakeHome }).installed, false);
const fakePluginDir = path.join(fakeHome, '.gemini', 'config', 'plugins', 'agy-tokless');
fs.mkdirSync(fakePluginDir, { recursive: true });
fs.writeFileSync(path.join(fakePluginDir, 'plugin.json'), JSON.stringify({ name: 'agy-tokless', disabled: false }), 'utf8');
const detected = rootPkg.detectGlobalPlugin({ homeDir: fakeHome });
assert.strictEqual(detected.installed, true);
assert.strictEqual(detected.enabled, true);

let blocked = false;
try {
  require('tokless/tools/agy-audit/cli.js');
} catch (err) {
  blocked = err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}
assert.strictEqual(blocked, true, 'Unexported internal path should throw ERR_PACKAGE_PATH_NOT_EXPORTED');
`,
    'utf8'
  );

  execFileSync(process.execPath, [consumerScript], {
    cwd: consumerDir,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  console.log('  [PASS] 4. Programmatic package.json exports (., ./skeleton, ./audit, ./read-guard, ./package.json)');
}

function testUnifiedCliAndCrossAgentTargets(tmpDir) {
  const cliPath = path.join(REPO_ROOT, 'bin', 'tokless.js');
  const { shouldForceCopy } = require(path.join(REPO_ROOT, 'targets', 'shared.js'));

  assert.strictEqual(shouldForceCopy('/tmp/_npx/abc123/node_modules/tokless', false), true);
  assert.strictEqual(shouldForceCopy('C:\\npm-cache\\_npx\\123\\tokless', false), true);
  assert.strictEqual(shouldForceCopy('/opt/local/repo/tokless', false), false);
  assert.strictEqual(shouldForceCopy('/opt/local/repo/tokless', true), true);

  const verOut = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' }).trim();
  assert.strictEqual(verOut, EXPECTED_VERSION);
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  assert.strictEqual(pluginManifest.version, EXPECTED_VERSION);

  const { bumpVersion } = require(path.join(REPO_ROOT, 'scripts', 'bump-version.js'));
  const bumpSandbox = path.join(tmpDir, 'bump-sandbox');
  fs.mkdirSync(bumpSandbox, { recursive: true });
  fs.writeFileSync(path.join(bumpSandbox, 'package.json'), JSON.stringify({ name: 'tokless', version: '0.1.0' }), 'utf8');
  fs.writeFileSync(path.join(bumpSandbox, 'plugin.json'), JSON.stringify({ name: 'agy-tokless', version: '0.1.0' }), 'utf8');
  bumpVersion('v1.2.3', { rootDir: bumpSandbox });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(bumpSandbox, 'package.json'), 'utf8')).version, '1.2.3');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(bumpSandbox, 'plugin.json'), 'utf8')).version, '1.2.3');

  const helpOut = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert(helpOut.includes('tokless install') && helpOut.includes('--with-guard') && helpOut.includes('tokless skeleton') && helpOut.includes('tokless audit'));

  const sampleJs = path.join(tmpDir, 'cli-skel-sample.js');
  const sampleLines = [];
  for (let i = 1; i <= 840; i++) {
    sampleLines.push(i === 12 ? 'function sampleTargetFn(a, b) { return a + b; }' : `const v${i} = ${i};`);
  }
  fs.writeFileSync(sampleJs, sampleLines.join('\n'), 'utf8');

  const skelJsonRaw = execFileSync(process.execPath, [cliPath, 'skeleton', sampleJs, '--json'], { encoding: 'utf8' });
  const skelJson = JSON.parse(skelJsonRaw);
  assert.strictEqual(skelJson.mode, 'file');
  assert.strictEqual(skelJson.totalLines, 840);
  assert(skelJson.formatted.includes('function sampleTargetFn(a, b)'));

  const auditSessionJsonl = path.join(tmpDir, 'cli-audit-session.jsonl');
  fs.writeFileSync(
    auditSessionJsonl,
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-06-01T10:00:00Z', content: 'Audit CLI' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-06-01T10:00:03Z', input_tokens: 900, output_tokens: 50, cache_read_tokens: 600 })
    ].join('\n'),
    'utf8'
  );
  const auditJsonRaw = execFileSync(process.execPath, [cliPath, 'audit', 'session', auditSessionJsonl, '--json'], { encoding: 'utf8' });
  const auditJson = JSON.parse(auditJsonRaw);
  assert.strictEqual(auditJson.stats.totalInputTokens, 900);

  const isolatedHome = path.join(tmpDir, 'isolated-multi-agent-home');
  const claudeDir = path.join(isolatedHome, '.claude');
  const codexDir = path.join(isolatedHome, '.codex');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  const existingSettings = {
    theme: 'dark',
    permissions: { allow: ['Bash(git status)'] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'echo custom-bash-guard', timeout: 5 }]
        }
      ],
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [{ type: 'command', command: 'echo post-write' }]
        }
      ]
    }
  };
  const claudeSettingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(claudeSettingsPath, JSON.stringify(existingSettings, null, 2), 'utf8');

  const envWithHome = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome };
  const agyPluginDir = path.join(isolatedHome, '.gemini', 'config', 'plugins', 'agy-tokless');
  const agyHooksPath = path.join(agyPluginDir, 'hooks.json');

  // 1) Default install MUST NOT mount PreToolUse hooks.json or Claude Read hook
  execFileSync(process.execPath, [cliPath, 'install', '--copy'], {
    env: envWithHome,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  assert(fs.existsSync(path.join(agyPluginDir, 'plugin.json')));
  assert(!fs.existsSync(agyHooksPath), 'Default install must not generate hooks.json');
  assert(fs.existsSync(path.join(agyPluginDir, 'tools', 'repo-skeleton', 'lib', 'core', 'registry.js')));
  assert(fs.existsSync(path.join(agyPluginDir, 'tools', 'repo-skeleton', 'lib', 'langs', 'java', 'index.js')));
  assert(fs.existsSync(path.join(claudeDir, 'tokless', 'scripts', 'read-guard-hook.js')));
  assert(fs.existsSync(path.join(claudeDir, 'tokless', 'tools', 'repo-skeleton', 'lib', 'core', 'registry.js')));
  assert(fs.existsSync(path.join(claudeDir, 'tokless', 'tools', 'repo-skeleton', 'lib', 'langs', 'java', 'index.js')));
  assert(fs.existsSync(path.join(claudeDir, 'skills', 'code-skeleton', 'SKILL.md')));
  assert(fs.existsSync(path.join(codexDir, 'skills', 'code-skeleton', 'SKILL.md')));
  assert(fs.existsSync(path.join(codexDir, 'skills', 'code-skeleton', 'tools', 'repo-skeleton', 'lib', 'core', 'registry.js')));
  assert(fs.existsSync(path.join(codexDir, 'skills', 'code-skeleton', 'tools', 'repo-skeleton', 'lib', 'langs', 'java', 'index.js')));

  const defaultClaudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
  assert.strictEqual(defaultClaudeSettings.hooks.PreToolUse.length, 1, 'Default install must not inject Claude Read hook');
  assert.strictEqual(defaultClaudeSettings.hooks.PreToolUse[0].matcher, 'Bash');

  // 2) Opt-in --with-guard install MUST mount hooks.json and idempotently merge Claude Read hook
  execFileSync(process.execPath, [cliPath, 'install', '--with-guard', '--copy'], {
    env: envWithHome,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  execFileSync(process.execPath, [cliPath, 'install', '--target', 'claude', '--with-guard', '--copy'], {
    env: envWithHome,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  assert(fs.existsSync(agyHooksPath), '--with-guard must generate Antigravity hooks.json');
  const mergedSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
  assert.strictEqual(mergedSettings.theme, 'dark');
  assert.deepStrictEqual(mergedSettings.permissions, existingSettings.permissions);
  assert.strictEqual(mergedSettings.hooks.PostToolUse.length, 1);
  assert.strictEqual(mergedSettings.hooks.PreToolUse.length, 2, 'Should keep custom Bash hook + 1 tokless Read hook');

  const readHookGroup = mergedSettings.hooks.PreToolUse.find((g) => g.matcher === 'Read');
  assert(readHookGroup && readHookGroup.hooks.length === 1);
  const installedHookScript = path.join(claudeDir, 'tokless', 'scripts', 'read-guard-hook.js');
  assert(readHookGroup.hooks[0].command.includes('read-guard-hook.js'));

  const claudeDenyRes = spawnSync(
    process.execPath,
    [installedHookScript],
    {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: sampleJs }
      }),
      encoding: 'utf8'
    }
  );
  assert.strictEqual(claudeDenyRes.status, 0);
  const claudeDenyJson = JSON.parse(claudeDenyRes.stdout.trim());
  assert.strictEqual(claudeDenyJson.hookSpecificOutput.permissionDecision, 'deny');
  assert(claudeDenyJson.hookSpecificOutput.permissionDecisionReason.includes('function sampleTargetFn'));

  // 3) Re-running default install (without --with-guard) MUST automatically purge stale hooks
  execFileSync(process.execPath, [cliPath, 'install', '--copy'], {
    env: envWithHome,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  assert(!fs.existsSync(agyHooksPath), 'Re-running default install must remove stale Antigravity hooks.json');
  const autoCleanedSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
  assert.strictEqual(autoCleanedSettings.hooks.PreToolUse.length, 1, 'Re-running default install must remove stale Claude Read hook');
  assert.strictEqual(autoCleanedSettings.hooks.PreToolUse[0].matcher, 'Bash');

  // 4) Re-enable --with-guard and verify clean uninstall
  execFileSync(process.execPath, [cliPath, 'install', '--with-guard', '--copy'], {
    env: envWithHome,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  execFileSync(process.execPath, [cliPath, 'uninstall', '--target', 'all'], {
    env: envWithHome,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  assert(!fs.existsSync(path.join(isolatedHome, '.gemini', 'config', 'plugins', 'agy-tokless')));
  assert(!fs.existsSync(path.join(claudeDir, 'tokless')));
  assert(!fs.existsSync(path.join(claudeDir, 'skills', 'code-skeleton')));
  assert(!fs.existsSync(path.join(codexDir, 'skills', 'code-skeleton')));

  const unmergedSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
  assert.strictEqual(unmergedSettings.theme, 'dark');
  assert.strictEqual(unmergedSettings.hooks.PostToolUse.length, 1);
  assert.strictEqual(unmergedSettings.hooks.PreToolUse.length, 1);
  assert.strictEqual(unmergedSettings.hooks.PreToolUse[0].matcher, 'Bash');

  console.log('  [PASS] 5. Unified tokless CLI & isolated Antigravity / Claude Code / Codex targets');
}

function main() {
  console.log('Running tokless verification suite...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-test-'));
  try {
    testZeroPersonalPathLeak();
    testAgyAuditCacheCliffsAndMcpTax(tmpDir);
    testRepoSkeletonAndReadGuardHook(tmpDir);
    testProgrammaticPackageExports(tmpDir);
    testUnifiedCliAndCrossAgentTargets(tmpDir);
    console.log('\nALL tokless checks passed!');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
