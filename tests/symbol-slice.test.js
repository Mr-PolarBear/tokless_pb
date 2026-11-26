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
