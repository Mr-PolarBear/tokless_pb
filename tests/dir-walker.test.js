'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  IGNORED_DIRS,
  walkDirectory,
  scanDirectorySkeleton,
  generateRepoMap,
} = require('../index');

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(root, map) {
  for (const [rel, content] of Object.entries(map)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

test('dir-walker: ignores default dirs (.nuxt/.venv/venv/coverage/.turbo/cmake-build-*) and custom --exclude', () => {
  withTempDir('tokless-walker-defaults-', (dir) => {
    for (const d of ['.nuxt', '.venv', 'venv', 'coverage', '.turbo', 'node_modules', 'dist']) {
      assert.ok(IGNORED_DIRS.has(d), `expected IGNORED_DIRS to include ${d}`);
    }

    writeFiles(dir, {
      'src/app.js': 'export function app() { return 1; }\n',
      'src/generated/skip.js': 'export function gen() {}\n',
      '.nuxt/entry.js': 'export function nuxt() {}\n',
      '.venv/mod.py': 'def f():\n  pass\n',
      'venv/mod.py': 'def g():\n  pass\n',
      'coverage/report.js': 'function cov() {}\n',
      '.turbo/cache.js': 'function turbo() {}\n',
      'cmake-build-release/out.c': 'void cm(void) {}\n',
      'third_party/lib.js': 'function tp() {}\n',
    });

    const walked = walkDirectory(dir, { exclude: 'third_party,src/generated' });
    assert.deepEqual(
      walked.files.map((f) => f.relPath),
      ['src/app.js']
    );
  });
});

test('dir-walker: respects layered .gitignore (comments, trailing /, leading /, *, **, ?, negation !, nested .gitignore)', () => {
  withTempDir('tokless-walker-gitignore-', (dir) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

    writeFiles(dir, {
      '.gitignore': [
        '\uFEFF# Root ignore rules',
        '',
        '/root_only.js',
        'logs/',
        '*.gen.js',
        '!keep.gen.js',
        'tmp?.js',
        '**/snap/*.js',
        'deep/**/drop.js',
        'gen/*',
        '!gen/preserved.js',
        'dir_only.js/',
      ].join('\r\n'),
      'root_only.js': 'function r1() {}\n',
      'src/root_only.js': 'function r2() {}\n',
      'logs/app.js': 'function logFn() {}\n',
      'src/a.gen.js': 'function genA() {}\n',
      'src/keep.gen.js': 'function keepGen() {}\n',
      'src/tmp1.js': 'function t1() {}\n',
      'src/tmp12.js': 'function t12() {}\n',
      'a/b/snap/item.js': 'function snapFn() {}\n',
      'deep/x/y/drop.js': 'function dropDeep() {}\n',
      'deep/drop.js': 'function dropDirect() {}\n',
      'deep/keep.js': 'function keepDeep() {}\n',
      'gen/ignored.js': 'function genIgn() {}\n',
      'gen/preserved.js': 'function genKeep() {}\n',
      'dir_only.js': 'function fileNamedLikeDir() {}\n',
      'packages/app/.gitignore': [
        'local_scratch/',
        '!override.gen.js',
      ].join('\n'),
      'packages/app/local_scratch/x.js': 'function scratch() {}\n',
      'packages/app/override.gen.js': 'function overrideGen() {}\n',
      'packages/app/other.gen.js': 'function otherGen() {}\n',
      'packages/app/main.js': 'function appMain() {}\n',
      'packages/lib/override.gen.js': 'function libGen() {}\n',
      'packages/lib/index.js': 'function libMain() {}\n',
    });

    const walked = walkDirectory(dir);
    const rels = walked.files.map((f) => f.relPath).sort();

    assert.deepEqual(rels, [
      'deep/keep.js',
      'dir_only.js',
      'gen/preserved.js',
      'packages/app/main.js',
      'packages/app/override.gen.js',
      'packages/lib/index.js',
      'src/keep.gen.js',
      'src/root_only.js',
      'src/tmp12.js',
    ]);

    for (const rel of rels) {
      assert.ok(!rel.includes('\\'), `expected POSIX forward slashes in ${rel}`);
    }
  });
});

test('dir-walker: explicit target penetration for node_modules/pkg, dist/client, and gitignored dirs while regular subdirs inherit root .gitignore', () => {
  withTempDir('tokless-walker-penetrate-', (dir) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });

    writeFiles(dir, {
      '.gitignore': [
        '*.secret.js',
        'generated_out/',
        'vendor/sdk/',
      ].join('\n'),
      'src/.gitignore': '*.local.ts\n',
      'src/core/app.js': 'export function coreApp() { return 1; }\n',
      'src/core/leak.secret.js': 'export function leak() {}\n',
      'src/core/dev.local.ts': 'export function devLocal() {}\n',
      'src/core/generated_out/x.js': 'export function nestedGen() {}\n',
      'generated_out/ok.js': 'export function genOk() { return 2; }\n',
      'generated_out/node_modules/dep/bad.js': 'export function badDep() {}\n',
      'vendor/sdk/index.js': 'export function sdkInit() { return 3; }\n',
      'vendor/sdk/dist/bundle.js': 'export function sdkBundle() {}\n',
      'dist/client/main.js': 'export function clientMain() { return 4; }\n',
      'dist/client/dist/nested.js': 'export function nestedDist() {}\n',
      'dist/client/node_modules/pkg/x.js': 'export function nestedNm() {}\n',
      'node_modules/some-pkg/.gitignore': 'pkg_tmp/\n',
      'node_modules/some-pkg/src/index.js': 'export function pkgMain() { return 5; }\n',
      'node_modules/some-pkg/src/helper.secret.js': 'export function pkgSecret() { return 6; }\n',
      'node_modules/some-pkg/pkg_tmp/scratch.js': 'export function pkgScratch() {}\n',
      'node_modules/some-pkg/node_modules/inner/dep.js': 'export function innerDep() {}\n',
      'node_modules/some-pkg/dist/built.js': 'export function pkgBuilt() {}\n',
      'node_modules/some-pkg/nested-repo/.git/hook.js': 'export function pkgGit() {}\n',
      'node_modules/git-pkg/.git/hook.js': 'export function ownGitHook() {}\n',
      'node_modules/git-pkg/src/main.js': 'export function gitPkgMain() { return 7; }\n',
    });

    // 1. Regular subdirectory inherits repo root .gitignore and intermediate src/.gitignore
    const coreWalk = walkDirectory(path.join(dir, 'src', 'core'));
    assert.equal(coreWalk.penetrated, false);
    assert.deepEqual(
      coreWalk.files.map((f) => f.relPath),
      ['app.js']
    );

    // 2. Explicit target inside node_modules/some-pkg penetrates parent ignores,
    //    applies its own .gitignore and still ignores nested node_modules/dist/.git
    const pkgDir = path.join(dir, 'node_modules', 'some-pkg');
    const pkgWalk = walkDirectory(pkgDir);
    assert.equal(pkgWalk.penetrated, true);
    assert.deepEqual(
      pkgWalk.files.map((f) => f.relPath).sort(),
      ['src/helper.secret.js', 'src/index.js']
    );

    // 2b. Package inside node_modules that has its own .git root still ignores its .git and scans src
    const gitPkgWalk = walkDirectory(path.join(dir, 'node_modules', 'git-pkg'));
    assert.deepEqual(
      gitPkgWalk.files.map((f) => f.relPath),
      ['src/main.js']
    );

    // 3. Explicit target inside dist/client penetrates dist but still ignores nested dist & node_modules
    const distClientWalk = walkDirectory(path.join(dir, 'dist', 'client'));
    assert.equal(distClientWalk.penetrated, true);
    assert.deepEqual(
      distClientWalk.files.map((f) => f.relPath),
      ['main.js']
    );

    // 4. Explicit target inside .gitignore-ignored directories penetrates and becomes new ignore root
    const genWalk = walkDirectory(path.join(dir, 'generated_out'));
    assert.equal(genWalk.penetrated, true);
    assert.deepEqual(
      genWalk.files.map((f) => f.relPath),
      ['ok.js']
    );

    const sdkWalk = walkDirectory(path.join(dir, 'vendor', 'sdk'));
    assert.equal(sdkWalk.penetrated, true);
    assert.deepEqual(
      sdkWalk.files.map((f) => f.relPath),
      ['index.js']
    );

    // 5. skeleton and --map share dir-walker: respect .gitignore at root and penetrate explicit node_modules/some-pkg
    const rootSkel = scanDirectorySkeleton(dir, { depth: 4 });
    assert.deepEqual(
      rootSkel.files.map((f) => f.relPath),
      ['src/core/app.js']
    );

    const rootMap = generateRepoMap(dir);
    assert.deepEqual(
      rootMap.files.map((f) => f.relPath),
      ['src/core/app.js']
    );

    const pkgSkel = scanDirectorySkeleton(pkgDir, { depth: 4 });
    assert.deepEqual(
      pkgSkel.files.map((f) => f.relPath).sort(),
      ['src/helper.secret.js', 'src/index.js']
    );

    const pkgMap = generateRepoMap(pkgDir);
    assert.deepEqual(
      pkgMap.files.map((f) => f.relPath).sort(),
      ['src/helper.secret.js', 'src/index.js']
    );
  });
});

test('dir-walker: prevents symlink/junction infinite cycles while allowing symlink entry directories', () => {
  withTempDir('tokless-walker-symlink-', (baseDir) => {
    const realRoot = path.join(baseDir, 'real-project');
    const subDir = path.join(realRoot, 'sub');
    writeFiles(realRoot, {
      'src/app.js': 'export function app() { return 1; }\n',
      'sub/nested.js': 'export function nested() { return 2; }\n',
    });

    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(realRoot, path.join(subDir, 'loop-root'), linkType);
    fs.symlinkSync(subDir, path.join(subDir, 'loop-self'), linkType);

    const entryLink = path.join(baseDir, 'project-link');
    fs.symlinkSync(realRoot, entryLink, linkType);

    // Direct walk on realRoot must terminate and visit each file once
    const directRes = walkDirectory(realRoot);
    assert.deepEqual(
      directRes.files.map((f) => f.relPath).sort(),
      ['src/app.js', 'sub/nested.js']
    );

    // Entry via symlink/junction must enter normally and still break internal cycles
    const linkedRes = walkDirectory(entryLink);
    assert.deepEqual(
      linkedRes.files.map((f) => f.relPath).sort(),
      ['src/app.js', 'sub/nested.js']
    );
  });
});
