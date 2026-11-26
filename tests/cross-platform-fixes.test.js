'use strict';

const assert = require('node:assert/strict');
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

test('install.js omits hooks.json by default, writes executable absolute node path with --with-guard, and cleans up on re-install', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tokless-install-'));
  try {
    const installEnv = { ...process.env, HOME: tempHome, USERPROFILE: tempHome };
    const pluginDir = path.join(tempHome, '.gemini', 'config', 'plugins', 'agy-tokless');
    const hooksPath = path.join(pluginDir, 'hooks.json');

    // 1) Default install omits hooks.json
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'install.js'), '--copy'], {
      env: installEnv,
      stdio: 'pipe',
    });
    assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')), 'plugin.json should be installed');
    assert.ok(!fs.existsSync(hooksPath), 'hooks.json must not be installed without --with-guard');

    // 2) --with-guard writes absolute node path into hooks.json
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'install.js'), '--with-guard', '--copy'], {
      env: installEnv,
      stdio: 'pipe',
    });
    assert.ok(fs.existsSync(hooksPath), 'hooks.json should be installed when --with-guard is passed');

    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const command = hooks['read-file-guard'].PreToolUse[0].hooks[0].command;
    assert.ok(
      !command.startsWith('node '),
      `expected absolute node path instead of bare node, got: ${command}`
    );
    assert.ok(
      command.includes('./scripts/read-guard-hook.js'),
      `expected read-guard-hook.js in command, got: ${command}`
    );

    const largeFile = path.join(tempHome, 'large-target.js');
    const largeLines = [];
    for (let i = 1; i <= 850; i++) {
      largeLines.push(i === 8 ? 'function guardedEntry() { return 42; }' : `const row${i} = ${i};`);
    }
    fs.writeFileSync(largeFile, largeLines.join('\n'), 'utf8');

    const minimalEnv =
      process.platform === 'win32'
        ? { ...process.env }
        : { PATH: '/usr/bin:/bin', HOME: tempHome };

    // 3) Unsliced blind read of >800-line file must be denied with skeleton line ranges
    const blindPayload = JSON.stringify({
      toolCall: { name: 'read_file', args: { Path: largeFile } },
    });
    const denyOut = execSync(command, {
      cwd: pluginDir,
      env: minimalEnv,
      input: blindPayload,
      encoding: 'utf8',
    });
    const denyJson = JSON.parse(denyOut.trim());
    assert.equal(denyJson.decision, 'deny');
    assert.match(denyJson.reason, /\[L\d+-L\d+\]/);

    // 4) Explicit line range (even L1-L850) must be allowed
    const rangedPayload = JSON.stringify({
      toolCall: { name: 'read_file', args: { Path: largeFile, StartLine: 1, EndLine: 850 } },
    });
    const allowOut = execSync(command, {
      cwd: pluginDir,
      env: minimalEnv,
      input: rangedPayload,
      encoding: 'utf8',
    });
    const allowJson = JSON.parse(allowOut.trim());
    assert.equal(allowJson.decision, 'allow');

    // 5) Re-running default install cleans up stale hooks.json
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'install.js'), '--copy'], {
      env: installEnv,
      stdio: 'pipe',
    });
    assert.ok(!fs.existsSync(hooksPath), 're-running default install should remove stale hooks.json');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('paths.js resolves valid full ID directly without scanning brainRoot and rejects traversal inputs', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tokless-paths-'));
  const validId = '0f2c2da1-f2ef-41b3-b889-b71af8c3f7f5';
  const brainRoot = path.join(tempHome, '.gemini', 'antigravity', 'brain');
  fs.mkdirSync(path.join(brainRoot, validId), { recursive: true });

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const origReaddirSync = fs.readdirSync;

  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Reload paths module cleanly
    const pathsModPath = path.join(REPO_ROOT, 'tools', 'agy-audit', 'lib', 'paths.js');
    delete require.cache[require.resolve(pathsModPath)];
    const { resolveConversationId, getConversationBrainDir } = require(pathsModPath);

    // Block readdirSync on brainRoot to prove full-ID direct hit avoids directory scan
    fs.readdirSync = (...args) => {
      if (path.resolve(String(args[0])) === path.resolve(brainRoot)) {
        const err = new Error('EPERM: simulated sandbox scandir block');
        err.code = 'EPERM';
        throw err;
      }
      return origReaddirSync(...args);
    };

    assert.equal(resolveConversationId(validId), validId);
    assert.equal(
      getConversationBrainDir(validId),
      path.resolve(brainRoot, validId)
    );

    // Restore readdirSync to verify traversal rejection even when scanning is allowed
    fs.readdirSync = origReaddirSync;

    const maliciousInputs = [
      '..',
      '.',
      '../../..',
      '../outside',
      'foo/bar',
      'foo\\bar',
      'valid\0evil',
    ];
    for (const bad of maliciousInputs) {
      assert.throws(
        () => resolveConversationId(bad),
        /Invalid conversation ID/,
        `resolveConversationId should reject traversal input: ${JSON.stringify(bad)}`
      );
      assert.throws(
        () => getConversationBrainDir(bad),
        /Invalid conversation ID/,
        `getConversationBrainDir should reject traversal input: ${JSON.stringify(bad)}`
      );
    }
  } finally {
    fs.readdirSync = origReaddirSync;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('SKILL.md files avoid POSIX-only parameter expansion and document both Unix and PowerShell commands', () => {
  const skillFiles = [
    path.join(REPO_ROOT, 'skills', 'code-skeleton', 'SKILL.md'),
    path.join(REPO_ROOT, 'skills', 'token-audit', 'SKILL.md'),
  ];
  for (const file of skillFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(
      !content.includes('${PLUGIN_ROOT:-'),
      `${file} should not use POSIX-only \${PLUGIN_ROOT:-...} expansion`
    );
    assert.ok(
      content.includes('$HOME/.gemini/config/plugins/agy-tokless'),
      `${file} should include macOS/Linux command path`
    );
    assert.ok(
      content.includes('$env:USERPROFILE\\.gemini\\config\\plugins\\agy-tokless'),
      `${file} should include Windows PowerShell command path`
    );
  }
});
