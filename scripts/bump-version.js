#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const PLUGIN_PATH = path.join(REPO_ROOT, 'plugin.json');
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function bumpVersion(rawTarget, options = {}) {
  const rootDir = options.rootDir || REPO_ROOT;
  const pkgPath = path.join(rootDir, 'package.json');
  const pluginPath = path.join(rootDir, 'plugin.json');

  const pkg = readJson(pkgPath);
  const plugin = readJson(pluginPath);

  const normalized = options.syncFromPkg
    ? String(pkg.version || '').trim()
    : String(rawTarget || '').trim().replace(/^v/i, '');

  if (!SEMVER_RE.test(normalized)) {
    throw new Error(
      `Invalid semver version "${rawTarget || ''}". Usage: npm run bump -- <major.minor.patch>`
    );
  }

  const prevPkg = pkg.version;
  const prevPlugin = plugin.version;

  pkg.version = normalized;
  plugin.version = normalized;

  writeJson(pkgPath, pkg);
  writeJson(pluginPath, plugin);

  return {
    version: normalized,
    updated: [
      { file: 'package.json', from: prevPkg, to: normalized },
      { file: 'plugin.json', from: prevPlugin, to: normalized },
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  const syncFromPkg = args.includes('--sync-from-pkg');
  const positional = args.find((a) => !a.startsWith('-'));

  if (!syncFromPkg && !positional) {
    console.error('Usage: npm run bump -- <version>  (e.g. npm run bump -- 0.5.2)');
    process.exit(1);
  }

  try {
    const result = bumpVersion(positional, { syncFromPkg });
    for (const item of result.updated) {
      console.log(`[bump] ${item.file}: ${item.from} -> ${item.to}`);
    }
  } catch (err) {
    console.error(`[bump] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { bumpVersion };
