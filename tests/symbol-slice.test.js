'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKLESS_BIN = path.join(REPO_ROOT, 'bin', 'tokless.js');
const SKELETON_CLI = path.join(REPO_ROOT, 'tools', 'repo-skeleton', 'cli.js');

const {
  parseSliceTarget,
  locateSymbol,
  sliceSymbol,
  sliceSymbolFromText,
  generateSkeleton,
} = require('../index');

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('JS/TS symbol slice: Class.method, get/set property pair, fn() tolerance, and line drift resilience', () => {
  const tsCode = [
    'export class SessionStore {',
    '  private count = 0;',
    '',
    '  get activeCount(): number {',
    '    return this.count;',
    '  }',
    '',
    '  set activeCount(next: number) {',
    '    this.count = Math.max(0, next);',
    '  }',
    '',
    '  commitBatch(items: string[]): number {',
    '    this.count += items.length;',
    '    return this.count;',
    '  }',
    '}',
    '',
    'export function normalizeKey(raw: string): string {',
    '  return raw.trim().toLowerCase();',
    '}',
  ].join('\n');

  withTempDir('tokless-slice-ts-', (dir) => {
    const filePath = path.join(dir, 'store.ts');
    fs.writeFileSync(filePath, tsCode, 'utf8');

    // 1. Class.method exact slice
    const methodRes = sliceSymbol(`${filePath}#SessionStore.commitBatch`);
    assert.equal(methodRes.ok, true);
    assert.equal(methodRes.found, true);
    assert.equal(methodRes.matchCount, 1);
    assert.equal(methodRes.matches[0].qualifiedName, 'SessionStore.commitBatch');
    assert.equal(methodRes.matches[0].startLine, 12);
    assert.equal(methodRes.matches[0].endLine, 15);
    assert.ok(methodRes.matches[0].content.includes('this.count += items.length;'));

    // 2. Paired getter + setter returned together in ascending startLine order
    const propRes = sliceSymbol(filePath, 'SessionStore.activeCount');
    assert.equal(propRes.found, true);
    assert.equal(propRes.matchCount, 2);
    assert.equal(propRes.matches[0].startLine, 4);
    assert.equal(propRes.matches[0].endLine, 6);
    assert.ok(propRes.matches[0].signature.includes('get activeCount'));
    assert.equal(propRes.matches[1].startLine, 8);
    assert.equal(propRes.matches[1].endLine, 10);
    assert.ok(propRes.matches[1].signature.includes('set activeCount'));

    // 3. Trailing empty parens tolerance: normalizeKey()
    const fnRes = sliceSymbol(filePath, 'normalizeKey()');
    assert.equal(fnRes.found, true);
    assert.equal(fnRes.matchCount, 1);
    assert.equal(fnRes.matches[0].name, 'normalizeKey');
    assert.equal(fnRes.matches[0].startLine, 18);
    assert.equal(fnRes.matches[0].endLine, 20);

    // 4. Insert 10 comment lines at the top of the file -> same #SessionStore.commitBatch query tracks drifted lines
    const tenCommentLines = Array.from({ length: 10 }, (_, idx) => `// Header comment line ${idx + 1}`).join('\n');
    fs.writeFileSync(filePath, `${tenCommentLines}\n${tsCode}`, 'utf8');

    const driftedRes = sliceSymbol(`${filePath}#SessionStore.commitBatch`);
    assert.equal(driftedRes.found, true);
    assert.equal(driftedRes.matchCount, 1);
    assert.equal(driftedRes.matches[0].startLine, 22);
    assert.equal(driftedRes.matches[0].endLine, 25);
    assert.equal(driftedRes.matches[0].content, methodRes.matches[0].content);

    // generateSkeleton delegation when symbol option is supplied
    const delegated = generateSkeleton(filePath, { symbol: 'SessionStore.commitBatch' });
    assert.equal(delegated.mode, 'slice');
    assert.equal(delegated.found, true);
    assert.equal(delegated.matches[0].startLine, 22);
  });
});

test('Python, Go, Rust, C++, and Markdown multi-language symbol slicing', () => {
  // Python: ClassName.method_name including @decorator start/end boundaries
  const pyCode = [
    'class TaskPipeline:',
    '    def __init__(self, name: str):',
    '        self.name = name',
    '',
    '    @classmethod',
    '    @retry(times=3)',
    '    def build_default(cls, env: str):',
    '        prefix = env.strip()',
    '        return cls(prefix)',
    '',
    '    def close(self):',
    '        return True',
  ].join('\n');

  const pyRes = sliceSymbolFromText(pyCode, '.py', 'TaskPipeline.build_default');
  assert.equal(pyRes.found, true);
  assert.equal(pyRes.matchCount, 1);
  assert.equal(pyRes.matches[0].startLine, 5);
  assert.equal(pyRes.matches[0].endLine, 9);
  assert.ok(pyRes.matches[0].content.startsWith('    @classmethod'));
  assert.ok(pyRes.matches[0].content.includes('return cls(prefix)'));

  // Go: pointer/value receiver method Server.Run and bare Run
  const goCode = [
    'package httpd',
    '',
    'type Server struct {',
    '    addr string',
    '}',
    '',
    'func NewServer(addr string) *Server {',
    '    return &Server{addr: addr}',
    '}',
    '',
    'func (s *Server) Run(ctx Context) error {',
    '    if s.addr == "" {',
    '        return ErrInvalidAddr',
    '    }',
    '    return nil',
    '}',
  ].join('\n');

  const goQual = sliceSymbolFromText(goCode, '.go', 'Server.Run');
  assert.equal(goQual.found, true);
  assert.equal(goQual.matchCount, 1);
  assert.equal(goQual.matches[0].qualifiedName, 'Server.Run');
  assert.equal(goQual.matches[0].startLine, 11);
  assert.equal(goQual.matches[0].endLine, 16);

  const goShort = sliceSymbolFromText(goCode, '.go', 'Run');
  assert.equal(goShort.found, true);
  assert.equal(goShort.matches[0].startLine, 11);
  assert.equal(goShort.matches[0].endLine, 16);

  // Rust: impl Foo & impl Trait for Foo via Foo.method and Foo::method
  const rsCode = [
    'pub struct WorkerPool {',
    '    cap: usize,',
    '}',
    '',
    'impl WorkerPool {',
    '    pub fn new(cap: usize) -> Self {',
    '        Self { cap }',
    '    }',
    '',
    '    pub fn spawn_job(&self, id: u64) -> bool {',
    '        id < self.cap as u64',
    '    }',
    '}',
    '',
    'impl Display for WorkerPool {',
    '    fn fmt(&self, f: &mut Formatter) -> Result {',
    '        write!(f, "pool({})", self.cap)',
    '    }',
    '}',
  ].join('\n');

  const rsDot = sliceSymbolFromText(rsCode, '.rs', 'WorkerPool.spawn_job');
  assert.equal(rsDot.found, true);
  assert.equal(rsDot.matchCount, 1);
  assert.equal(rsDot.matches[0].startLine, 10);
  assert.equal(rsDot.matches[0].endLine, 12);

  const rsColon = sliceSymbolFromText(rsCode, '.rs', 'WorkerPool::fmt');
  assert.equal(rsColon.found, true);
  assert.equal(rsColon.matchCount, 1);
  assert.equal(rsColon.matches[0].startLine, 16);
  assert.equal(rsColon.matches[0].endLine, 18);

  // C++: Namespace / Class::method and overloaded functions returned together
  const cppCode = [
    'namespace codec {',
    'class PacketReader {',
    'public:',
    '  int decode(const char* buf, int len) {',
    '    return len;',
    '  }',
    '  int decode(const std::string& payload) {',
    '    return static_cast<int>(payload.size());',
    '  }',
    '};',
    '}',
    '',
    'bool PacketReader::reset() {',
    '  return true;',
    '}',
  ].join('\n');

  const cppOverloads = sliceSymbolFromText(cppCode, '.cpp', 'codec::PacketReader::decode');
  assert.equal(cppOverloads.found, true);
  assert.equal(cppOverloads.matchCount, 2);
  assert.equal(cppOverloads.matches[0].startLine, 4);
  assert.equal(cppOverloads.matches[0].endLine, 6);
  assert.equal(cppOverloads.matches[1].startLine, 7);
  assert.equal(cppOverloads.matches[1].endLine, 9);

  const cppOutOfLine = sliceSymbolFromText(cppCode, '.cpp', 'PacketReader::reset');
  assert.equal(cppOutOfLine.found, true);
  assert.equal(cppOutOfLine.matchCount, 1);
  assert.equal(cppOutOfLine.matches[0].startLine, 13);
  assert.equal(cppOutOfLine.matches[0].endLine, 15);

  // Markdown: README.md#<section heading> exact section slice
  const readmePath = path.join(REPO_ROOT, 'README.md');
  const mdRes = sliceSymbol(`${readmePath}#License`);
  assert.equal(mdRes.found, true);
  assert.equal(mdRes.matchCount, 1);
  assert.ok(mdRes.matches[0].content.includes('## License'));
  assert.ok(mdRes.matches[0].content.includes('[MIT](./LICENSE)'));
  assert.ok(mdRes.matches[0].startLine >= 90);
  assert.ok(mdRes.matches[0].endLine >= mdRes.matches[0].startLine);
});

test('Symbol rename / typo fallback navigation: found=false, ranked suggestions, and full file symbol outline', () => {
  const jsCode = [
    'class OrderProcessor {',
    '  validateOrderPayload(order) {',
    '    return Boolean(order && order.id);',
    '  }',
    '',
    '  calculateShippingFee(weightKg) {',
    '    return weightKg * 12;',
    '  }',
    '}',
  ].join('\n');

  withTempDir('tokless-slice-miss-', (dir) => {
    const filePath = path.join(dir, 'processor.js');
    fs.writeFileSync(filePath, jsCode, 'utf8');

    const miss = sliceSymbol(filePath, 'OrderProcessor.validateOrderPaylod');
    assert.equal(miss.ok, false);
    assert.equal(miss.found, false);
    assert.equal(miss.matchCount, 0);
    assert.ok(Array.isArray(miss.suggestions) && miss.suggestions.length > 0);
    assert.equal(miss.suggestions[0].qualifiedName, 'OrderProcessor.validateOrderPayload');
    assert.ok(miss.formatted.includes('Symbol "OrderProcessor.validateOrderPaylod" not found'));
    assert.ok(miss.formatted.includes('Did you mean:'));
    assert.ok(miss.formatted.includes('Current symbols in file:'));
    assert.ok(miss.formatted.includes('[L1-L9] class OrderProcessor'));
    assert.ok(miss.formatted.includes('[L2-L4] validateOrderPayload(order)'));
    assert.ok(miss.formatted.includes('[L6-L8] calculateShippingFee(weightKg)'));

    const locMiss = locateSymbol(filePath, 'calculateShipFee');
    assert.equal(locMiss.found, false);
    assert.ok(locMiss.suggestions.some((s) => s.qualifiedName === 'OrderProcessor.calculateShippingFee'));
    assert.ok(locMiss.skeletonText.includes('[L6-L8]'));
  });
});

test('CLI integration: tokless slice <file>#<symbol>, --line-numbers, --json, exit code 2 on miss, and skeleton --symbol', () => {
  const sampleJs = [
    'function alphaHelper() {',
    '  return 1;',
    '}',
    '',
    'class Engine {',
    '  start(port) {',
    '    return port;',
    '  }',
    '}',
  ].join('\n');

  withTempDir('tokless-slice-cli-', (dir) => {
    const filePath = path.join(dir, 'engine.js');
    fs.writeFileSync(filePath, sampleJs, 'utf8');

    const parsed = parseSliceTarget(`${filePath}#Engine.start()`);
    assert.equal(parsed.filePath, filePath);
    assert.equal(parsed.symbol, 'Engine.start');

    // 1. tokless slice <file>#<symbol> --line-numbers
    const cliHit = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', `${filePath}#Engine.start`, '--line-numbers'],
      { encoding: 'utf8' }
    );
    assert.equal(cliHit.status, 0);
    assert.ok(cliHit.stdout.includes('[L6-L8] start(port)'));
    assert.ok(cliHit.stdout.includes('   6 |   start(port) {'));
    assert.ok(cliHit.stdout.includes('   7 |     return port;'));

    // 2. tokless slice <file> <symbol> --json
    const cliJson = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', filePath, 'alphaHelper', '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(cliJson.status, 0);
    const payload = JSON.parse(cliJson.stdout);
    assert.equal(payload.mode, 'slice');
    assert.equal(payload.found, true);
    assert.equal(payload.matches[0].name, 'alphaHelper');
    assert.equal(payload.matches[0].startLine, 1);
    assert.equal(payload.matches[0].endLine, 3);

    // 3. tokless skeleton <file> --symbol <symbol>
    const skelCli = spawnSync(
      process.execPath,
      [SKELETON_CLI, filePath, '--symbol', 'Engine.start'],
      { encoding: 'utf8' }
    );
    assert.equal(skelCli.status, 0);
    assert.ok(skelCli.stdout.includes('[L6-L8] start(port)'));
    assert.ok(skelCli.stdout.includes('return port;'));

    // 4. Not found exits with status 2 while printing fallback outline
    const cliMiss = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', `${filePath}#Engine.nonExistent`],
      { encoding: 'utf8' }
    );
    assert.equal(cliMiss.status, 2);
    assert.ok(cliMiss.stdout.includes('not found'));
    assert.ok(cliMiss.stdout.includes('Current symbols in file:'));
    assert.ok(cliMiss.stdout.includes('[L5-L9] class Engine'));
  });
});

function writeTree(root, filesMap) {
  for (const [rel, content] of Object.entries(filesMap)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

test('Cross-directory slice & locate: single hit (deep default Infinity depth, fast prefilter), tier priority isolation, and compact multi-hit expansion', () => {
  withTempDir('tokless-dir-slice-core-', (dir) => {
    writeTree(dir, {
      'src/a/b/c/d/deep_worker.ts': [
        'export class DeepWorker {',
        '  executeJob(id: string): boolean {',
        '    return id.length > 0;',
        '  }',
        '}',
      ].join('\n'),
      'src/noise1.js': 'export function unrelatedAlpha() { return 1; }\n',
      'src/noise2.py': 'def unrelated_beta():\n    return 2\n',
      'src/tier/z_exact.js': 'export function start() {\n  return "z";\n}\n',
      'src/tier/a_exact.js': 'export function start() {\n  return "a";\n}\n',
      'src/tier/b_case_mismatch.js': 'export function Start() {\n  return "upper";\n}\n',
      'src/nested/direct.js': 'class Inner {\n  run() {\n    return "direct";\n  }\n}\n',
      'src/nested/outer.js': 'class Outer {\n  classOnlyPlaceholder() {}\n}\n',
      'src/nested/deep.cpp': [
        'namespace Outer {',
        'class Inner {',
        'public:',
        '  int run() {',
        '    return 1;',
        '  }',
        '  int onlySuffix() {',
        '    return 2;',
        '  }',
        '};',
        '}',
      ].join('\n'),
    });

    // 1. Single hit deep inside directory (depth 5 > skeleton default 2) + fast prefilter skips unrelated files
    const single = sliceSymbol(`${dir}#DeepWorker.executeJob`, undefined, { lineNumbers: true });
    assert.equal(single.mode, 'slice');
    assert.equal(single.scope, 'directory');
    assert.equal(single.ok, true);
    assert.equal(single.found, true);
    assert.equal(single.displayMode, 'expanded');
    assert.equal(single.expanded, true);
    assert.equal(single.matchTier, 1);
    assert.equal(single.matchCount, 1);
    assert.equal(single.matches[0].relPath, 'src/a/b/c/d/deep_worker.ts');
    assert.ok(single.prefilterSkippedFiles >= 5, 'expected fast prefilter to skip unrelated files');
    assert.ok(single.formatted.startsWith('File: src/a/b/c/d/deep_worker.ts\n[L2-L4]'));
    assert.ok(single.formatted.includes('   2 |   executeJob(id: string): boolean {'));

    // locateSymbol on directory returns lightweight metadata without source content
    const located = locateSymbol(dir, 'DeepWorker.executeJob');
    assert.equal(located.scope, 'directory');
    assert.equal(located.found, true);
    assert.equal(located.matchCount, 1);
    assert.equal(located.matches[0].relPath, 'src/a/b/c/d/deep_worker.ts');
    assert.equal(located.matches[0].content, undefined);

    // 2. Tier priority isolation: Tier 1 exact ("start") excludes Tier 3 ("Start"), sorted by relPath
    const tierRes = sliceSymbol(dir, 'start');
    assert.equal(tierRes.found, true);
    assert.equal(tierRes.displayMode, 'expanded');
    assert.equal(tierRes.matchTier, 1);
    assert.equal(tierRes.matchCount, 2);
    assert.deepEqual(
      tierRes.matches.map((m) => m.relPath),
      ['src/tier/a_exact.js', 'src/tier/z_exact.js']
    );
    assert.ok(!tierRes.formatted.includes('b_case_mismatch.js'));
    assert.ok(tierRes.formatted.includes('File: src/tier/a_exact.js'));
    assert.ok(tierRes.formatted.includes('File: src/tier/z_exact.js'));

    // 3. Hierarchical tier isolation: Tier 1 ("Inner.run") beats Tier 4 suffix ("Outer.Inner.run")
    const hierTier1 = sliceSymbol(dir, 'Inner.run');
    assert.equal(hierTier1.found, true);
    assert.equal(hierTier1.matchTier, 1);
    assert.equal(hierTier1.matchCount, 1);
    assert.equal(hierTier1.matches[0].relPath, 'src/nested/direct.js');

    // When no Tier 1 exact exists, suffix segment Tier 4 matches Outer.Inner.onlySuffix
    const hierTier4 = sliceSymbol(dir, 'Inner.onlySuffix');
    assert.equal(hierTier4.found, true);
    assert.equal(hierTier4.matchTier, 4);
    assert.equal(hierTier4.matchCount, 1);
    assert.equal(hierTier4.matches[0].relPath, 'src/nested/deep.cpp');
    assert.equal(hierTier4.matches[0].qualifiedName, 'Outer.Inner.onlySuffix');
  });
});

test('Cross-directory slice anti-flood: auto navigation list (>3 hits or >200 lines), --all force expand, and single >200-line direct expand', () => {
  withTempDir('tokless-dir-slice-flood-', (dir) => {
    const bigBody = (name, count) => {
      const body = Array.from({ length: count }, (_, idx) => `  const v${idx} = ${idx};`).join('\n');
      return `export function ${name}() {\n${body}\n  return 0;\n}\n`;
    };

    writeTree(dir, {
      'm1.js': 'export function init() {\n  return 1;\n}\n',
      'm2.js': 'export function init() {\n  return 2;\n}\n',
      'm3.js': 'export function init() {\n  return 3;\n}\n',
      'm4.js': 'export function init() {\n  return 4;\n}\n',
      'm5.js': 'export function init() {\n  return 5;\n}\n',
      'large/a.js': bigBody('hugePair', 115),
      'large/b.js': bigBody('hugePair', 115),
      'large/single.js': bigBody('soloLarge', 215),
    });

    // 1. >3 matches automatically switches to full untruncated navigation list
    const listRes = sliceSymbol(dir, 'init');
    assert.equal(listRes.found, true);
    assert.equal(listRes.displayMode, 'list');
    assert.equal(listRes.expanded, false);
    assert.equal(listRes.matchCount, 5);
    assert.equal(listRes.matches[0].content, undefined);
    for (let i = 1; i <= 5; i++) {
      assert.ok(
        listRes.formatted.includes(`m${i}.js#init [L1-L3] (3 lines) — export function init()`),
        `missing m${i}.js in list output`
      );
    }
    assert.ok(listRes.formatted.includes('--all'));

    // 2. --all forces full source expansion for all 5 matches
    const allRes = sliceSymbol(dir, 'init', { all: true });
    assert.equal(allRes.found, true);
    assert.equal(allRes.displayMode, 'expanded');
    assert.equal(allRes.expanded, true);
    assert.equal(allRes.matchCount, 5);
    assert.ok(allRes.matches.every((m) => typeof m.content === 'string' && m.content.includes('return')));
    assert.ok(allRes.formatted.includes('File: m5.js'));

    // 3. <=3 matches (2 hits) whose combined lines exceed 200 auto-switches to list mode
    const oversizePair = sliceSymbol(dir, 'hugePair');
    assert.equal(oversizePair.found, true);
    assert.equal(oversizePair.matchCount, 2);
    assert.ok(oversizePair.totalSliceLines > 200);
    assert.equal(oversizePair.displayMode, 'list');
    assert.ok(oversizePair.formatted.includes('large/a.js#hugePair'));
    assert.ok(oversizePair.formatted.includes('large/b.js#hugePair'));

    const oversizePairAll = sliceSymbol(dir, 'hugePair', { all: true });
    assert.equal(oversizePairAll.displayMode, 'expanded');
    assert.ok(oversizePairAll.matches[0].content.includes('const v100 = 100;'));

    // 4. Single match >200 lines expands directly
    const soloRes = sliceSymbol(dir, 'soloLarge');
    assert.equal(soloRes.found, true);
    assert.equal(soloRes.matchCount, 1);
    assert.ok(soloRes.totalSliceLines > 200);
    assert.equal(soloRes.displayMode, 'expanded');
    assert.ok(soloRes.formatted.startsWith('File: large/single.js\n[L1-L'));
  });
});

test('Cross-directory slice 0-hit suggestions, .gitignore + explicit penetration, --depth/--exclude, and >2MB oversize skip', () => {
  withTempDir('tokless-dir-slice-guards-', (dir) => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const hugePad = '// ' + 'x'.repeat(2 * 1024 * 1024 + 1024) + '\n';

    writeTree(dir, {
      '.gitignore': 'ignored_dir/\n',
      'src/orders/processor.js': [
        'class OrderProcessor {',
        '  validateOrderPayload(order) {',
        '    return Boolean(order && order.id);',
        '  }',
        '}',
      ].join('\n'),
      'src/other/helper.js': 'export function unrelatedHelper() { return 42; }\n',
      'src/excluded/secret.js': 'export function excludedTarget() { return 1; }\n',
      'src/deep/l2/l3/buried.js': 'export function buriedTarget() { return 9; }\n',
      'ignored_dir/ghost.js': 'export function ghostTarget() { return 0; }\n',
      'node_modules/some-pkg/src/api.js': 'export function pkgApiHelper() { return 7; }\n',
      'node_modules/some-pkg/node_modules/inner/dup.js': 'export function pkgApiHelper() { return 8; }\n',
      'src/huge_bundle.js': `${hugePad}export function insideOversizeFile() { return 1; }\n`,
    });

    // 1. 0-hit returns Top <=5 cross-file Did you mean suggestions without dumping directory skeleton
    const miss = sliceSymbol(dir, 'OrderProcessor.validateOrderPaylod');
    assert.equal(miss.ok, false);
    assert.equal(miss.found, false);
    assert.equal(miss.displayMode, 'not_found');
    assert.ok(miss.suggestions.length >= 1 && miss.suggestions.length <= 5);
    assert.equal(miss.suggestions[0].relPath, 'src/orders/processor.js');
    assert.equal(miss.suggestions[0].qualifiedName, 'OrderProcessor.validateOrderPayload');
    assert.ok(miss.formatted.includes('Did you mean:'));
    assert.ok(
      miss.formatted.includes('src/orders/processor.js#OrderProcessor.validateOrderPayload [L2-L4]')
    );
    assert.ok(!miss.formatted.includes('unrelatedHelper'), '0-hit must never dump full directory skeleton');

    // 2. .gitignore & default node_modules are ignored from repo root
    assert.equal(sliceSymbol(dir, 'ghostTarget').found, false);
    assert.equal(sliceSymbol(dir, 'pkgApiHelper').found, false);

    // 3. Explicit penetration into node_modules/some-pkg finds pkgApiHelper and still skips nested node_modules
    const pkgHit = sliceSymbol(path.join(dir, 'node_modules', 'some-pkg'), 'pkgApiHelper');
    assert.equal(pkgHit.found, true);
    assert.equal(pkgHit.matchCount, 1);
    assert.equal(pkgHit.matches[0].relPath, 'src/api.js');

    // 4. --depth and --exclude work in cross-directory slice
    assert.equal(sliceSymbol(dir, 'buriedTarget', { depth: 1 }).found, false);
    assert.equal(sliceSymbol(dir, 'buriedTarget').found, true);
    assert.equal(sliceSymbol(dir, 'excludedTarget', { exclude: ['excluded'] }).found, false);
    assert.equal(sliceSymbol(dir, 'excludedTarget').found, true);

    // 5. Files > 2MB are skipped and recorded in stats
    const oversizeCheck = sliceSymbol(dir, 'insideOversizeFile');
    assert.equal(oversizeCheck.found, false);
    assert.equal(oversizeCheck.skippedOversizeFiles, 1);
    assert.deepEqual(oversizeCheck.oversizeFiles, ['src/huge_bundle.js']);
  });
});

test('Cross-directory CLI integration: tokless slice <dir> and repo-skeleton <dir> --symbol', () => {
  withTempDir('tokless-dir-slice-cli-', (dir) => {
    writeTree(dir, {
      'src/server.js': 'class Server {\n  boot(port) {\n    return port;\n  }\n}\n',
      'a.js': 'export function multiFn() { return 1; }\n',
      'b.js': 'export function multiFn() { return 2; }\n',
      'c.js': 'export function multiFn() { return 3; }\n',
      'd.js': 'export function multiFn() { return 4; }\n',
      'skipme/x.js': 'export function onlyExcluded() { return 0; }\n',
    });

    // 1. tokless slice <dir>#<symbol> --line-numbers
    const hitCli = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', `${dir}#Server.boot`, '--line-numbers'],
      { encoding: 'utf8' }
    );
    assert.equal(hitCli.status, 0);
    assert.ok(hitCli.stdout.includes('File: src/server.js'));
    assert.ok(hitCli.stdout.includes('   2 |   boot(port) {'));

    // 2. tokless slice <dir> <multiSymbol> switches to list; --all expands; --json has stable schema
    const listCli = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', dir, 'multiFn', '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(listCli.status, 0);
    const listJson = JSON.parse(listCli.stdout);
    assert.equal(listJson.scope, 'directory');
    assert.equal(listJson.displayMode, 'list');
    assert.equal(listJson.matchCount, 4);

    const allCli = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', dir, 'multiFn', '--all'],
      { encoding: 'utf8' }
    );
    assert.equal(allCli.status, 0);
    assert.ok(allCli.stdout.includes('File: d.js'));
    assert.ok(allCli.stdout.includes('return 4;'));

    // 3. --exclude via CLI
    const exclCli = spawnSync(
      process.execPath,
      [TOKLESS_BIN, 'slice', dir, 'onlyExcluded', '--exclude', 'skipme'],
      { encoding: 'utf8' }
    );
    assert.equal(exclCli.status, 2);

    // 4. repo-skeleton <dir> --symbol <query> (hit & miss exit code 2)
    const skelHit = spawnSync(
      process.execPath,
      [SKELETON_CLI, dir, '--symbol', 'Server.boot', '--line-numbers'],
      { encoding: 'utf8' }
    );
    assert.equal(skelHit.status, 0);
    assert.ok(skelHit.stdout.includes('File: src/server.js'));
    assert.ok(skelHit.stdout.includes('   3 |     return port;'));

    const skelMiss = spawnSync(
      process.execPath,
      [SKELETON_CLI, dir, '--symbol', 'Server.boott'],
      { encoding: 'utf8' }
    );
    assert.equal(skelMiss.status, 2);
    assert.ok(skelMiss.stdout.includes('Did you mean:'));
    assert.ok(skelMiss.stdout.includes('src/server.js#Server.boot'));

    // 5. Help outputs mention --all and directory support
    const sliceHelp = spawnSync(process.execPath, [TOKLESS_BIN, 'slice', '--help'], { encoding: 'utf8' });
    assert.equal(sliceHelp.status, 0);
    assert.ok(sliceHelp.stdout.includes('--all'));
    assert.ok(sliceHelp.stdout.includes('--depth'));
    assert.ok(sliceHelp.stdout.includes('--exclude'));

    const skelHelp = spawnSync(process.execPath, [SKELETON_CLI, '--help'], { encoding: 'utf8' });
    assert.equal(skelHelp.status, 0);
    assert.ok(skelHelp.stdout.includes('--all'));
  });
});
