#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS_DIR = __dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, '..');

function collectTestFiles(dir, out = []) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(fullPath);
    }
  }
  return out;
}

function runStep(args, label) {
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (res.error) {
    console.error(`[FAIL] ${label}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0 || res.signal) {
    process.exit(res.status || 1);
  }
}

function main() {
  const verifyScript = path.join(TESTS_DIR, 'verify-tokless.js');
  runStep([verifyScript], 'verify-tokless.js');

  const testFiles = collectTestFiles(TESTS_DIR);
  if (testFiles.length === 0) {
    console.error('[FAIL] No *.test.js files discovered under tests/');
    process.exit(1);
  }

  const relList = testFiles.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
  console.log(`\nRunning ${testFiles.length} auto-discovered test suite(s): ${relList.join(', ')}`);
  runStep(['--test', ...testFiles], 'node --test');
}

main();
