'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKELETON_LIB = path.join(REPO_ROOT, 'tools', 'repo-skeleton', 'lib', 'skeleton.js');
const REGISTRY_LIB = path.join(REPO_ROOT, 'tools', 'repo-skeleton', 'lib', 'core', 'registry.js');

function probeLoadedLangsInSubprocess(filesToCreate, scanArgsCode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-lazy-'));
  try {
    for (const [relName, content] of Object.entries(filesToCreate)) {
      const fullPath = path.join(tmpDir, relName);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }

    const probeScript = `
      const skel = require(${JSON.stringify(SKELETON_LIB)});
      const tmpDir = ${JSON.stringify(tmpDir)};
      const path = require('node:path');
      ${scanArgsCode}
      const loaded = Object.keys(require.cache)
        .map((p) => p.replace(/\\\\/g, '/'))
        .filter((p) => p.includes('/tools/repo-skeleton/lib/langs/'))
        .map((p) => {
          const m = p.match(/\\/tools\\/repo-skeleton\\/lib\\/langs\\/([^/]+)\\//);
          return m ? m[1] : p;
        });
      process.stdout.write(JSON.stringify([...new Set(loaded)].sort()));
    `;

    const res = spawnSync(process.execPath, ['-e', probeScript], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr || 'subprocess failed');
    return JSON.parse(res.stdout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('requiring skeleton.js and running --map mode loads zero language parsers', () => {
  const loaded = probeLoadedLangsInSubprocess(
    {
      'index.ts': 'export function boot(): number { return 1; }\n',
      'Main.java': 'public class Main { public static void main(String[] a) {} }\n',
      'app.py': 'def run():\n    return True\n',
    },
    'skel.generateRepoMap(tmpDir);'
  );
  assert.deepEqual(loaded, []);
});

test('scanning only .js and .ts files loads langs/javascript and never loads unrelated language parsers', () => {
  const loaded = probeLoadedLangsInSubprocess(
    {
      'a.js': 'function alpha() { return 1; }\n',
      'b.ts': 'export interface Config { port: number; }\nexport function beta(): void {}\n',
    },
    `
      skel.generateFileSkeleton(path.join(tmpDir, 'a.js'));
      skel.generateFileSkeleton(path.join(tmpDir, 'b.ts'));
    `
  );

  assert.deepEqual(loaded, ['javascript']);
  for (const forbidden of ['java', 'python', 'rust', 'go', 'c-family', 'kotlin', 'markdown', 'sfc']) {
    assert.ok(!loaded.includes(forbidden), `unexpected eager load of langs/${forbidden}`);
  }
});

test('scanning only .java loads langs/java exclusively', () => {
  const loaded = probeLoadedLangsInSubprocess(
    {
      'Demo.java': 'public class Demo { public int calc(int x) { return x + 1; } }\n',
    },
    `skel.generateFileSkeleton(path.join(tmpDir, 'Demo.java'));`
  );

  assert.deepEqual(loaded, ['java']);
});

test('every registered langs/<lang>/index.js matches LANG_DIR_TO_EXTS contract', () => {
  const { LANG_DIR_TO_EXTS, getLanguageHandler } = require(REGISTRY_LIB);
  const langDirs = Object.keys(LANG_DIR_TO_EXTS);
  assert.ok(langDirs.length >= 9);

  for (const [langDir, exts] of Object.entries(LANG_DIR_TO_EXTS)) {
    assert.ok(Array.isArray(exts) && exts.length > 0, `empty extensions for ${langDir}`);
    const handler = getLanguageHandler(exts[0]);
    assert.ok(handler, `missing handler for ${langDir}`);
    assert.equal(handler.id, langDir);
    assert.deepEqual(handler.extensions, exts);
    assert.equal(typeof handler.parse, 'function');
  }
});
