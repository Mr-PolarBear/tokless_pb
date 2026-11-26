#!/usr/bin/env node
'use strict';

const path = require('path');
const { resolveTargets } = require('./targets');
const { shouldForceCopy, resolveHomeDir } = require('./targets/shared');

function parseCliArgs(argv) {
  let target = null;
  let copy = false;
  let withGuard = false;
  let uninstall = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--copy') {
      copy = true;
    } else if (arg === '--with-guard') {
      withGuard = true;
    } else if (arg === '--uninstall') {
      uninstall = true;
    } else if (arg === '--target' || arg === '-t') {
      if (i + 1 < argv.length) {
        target = argv[i + 1];
        i++;
      }
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    }
  }

  return { target, copy, withGuard, uninstall, help };
}

function runInstall(options = {}) {
  const sourceDir = options.sourceDir || __dirname;
  const homeDir = resolveHomeDir(options);
  const forceCopy = shouldForceCopy(sourceDir, Boolean(options.copy));
  const withGuard = Boolean(options.withGuard);
  const mode = options.mode || 'antigravity-only';
  const adapters = resolveTargets(options.target, { homeDir, mode });

  const results = [];
  for (const adapter of adapters) {
    results.push(
      adapter.install({
        sourceDir,
        homeDir,
        copy: forceCopy,
        withGuard,
        silent: options.silent,
      })
    );
  }
  return results;
}

function runUninstall(options = {}) {
  const homeDir = resolveHomeDir(options);
  const mode = options.mode || 'antigravity-only';
  const adapters = resolveTargets(options.target, { homeDir, mode });

  const results = [];
  for (const adapter of adapters) {
    results.push(
      adapter.uninstall({
        homeDir,
        silent: options.silent,
      })
    );
  }
  return results;
}

function printHelp() {
  console.log(`Usage: node install.js [--target agy|claude|codex|all] [--with-guard] [--copy] [--uninstall]
  (default)             Install Antigravity plugin into ~/.gemini/config/plugins/agy-tokless (PreToolUse hook disabled by default)
  --target <hosts>      Target host(s): agy, claude, codex, all (comma-separated supported)
  --with-guard          Opt-in PreToolUse hook to return syntax skeleton on unsliced blind reads >800 lines (disabled by default)
  --copy                Copy all files instead of creating links (auto-enabled in _npx / node_modules)
  --uninstall           Remove installed tokless plugin/hooks for the selected target(s)`);
}

function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  try {
    if (parsed.uninstall) {
      runUninstall({
        target: parsed.target,
        mode: 'antigravity-only',
      });
      return;
    }
    runInstall({
      target: parsed.target,
      copy: parsed.copy,
      withGuard: parsed.withGuard,
      mode: 'antigravity-only',
    });
  } catch (err) {
    console.error(`[tokless] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseCliArgs,
  runInstall,
  runUninstall,
  install: runInstall,
  uninstall: runUninstall,
};
