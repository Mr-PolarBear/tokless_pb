'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateFileSkeleton } = require('../../tools/repo-skeleton/lib/skeleton');

function withTempSkeleton(fileName, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-polyglot-'));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    return fn(generateFileSkeleton(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('c-family: C++ namespace/class/~Destructor/operators/.hpp prototypes and C# properties', () => {
  const hppCode = [
    'namespace engine {',
    'class BufferPool {',
    'public:',
    '  BufferPool(int cap);',
    '  ~BufferPool() {',
    '    releaseAll();',
    '  }',
    '  bool operator==(const BufferPool& other) const {',
    '    return true;',
    '  }',
    '  void releaseAll();',
    '  DECLARE_INTERNAL_HOOK(BufferPool);',
    '};',
    '}',
  ].join('\n');

  withTempSkeleton('buffer_pool.hpp', hppCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'namespace:engine:d0',
      'class:BufferPool:d1',
      'method:BufferPool:d2',
      'method:~BufferPool:d2',
      'method:operator==:d2',
      'method:releaseAll:d2',
    ]);
  });

  const csCode = [
    'namespace Billing {',
    '  public class Invoice {',
    '    public decimal Total { get; set; }',
    '    public bool IsPaid(DateTime now) {',
    '      return Total >= 0;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  withTempSkeleton('Invoice.cs', csCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'namespace:Billing:d0',
      'class:Invoice:d1',
      'property:Total:d2',
      'method:IsPaid:d2',
    ]);
  });
});

test('kotlin: object, suspend fun, extension fun, expression-body lambda, and multiline raw strings', () => {
  const ktCode = [
    'object TokenCodec {',
    '    suspend fun decodePayload(raw: String): String {',
    '        val tpl = """',
    '            {"unclosed_in_raw": {',
    '        """',
    '        return raw + tpl',
    '    }',
    '}',
    '',
    'fun String.toSlug(): String = lowercase().trim()',
    '',
    'fun withRetry(times: Int) = run {',
    '    times + 1',
    '}',
  ].join('\n');

  withTempSkeleton('TokenCodec.kt', ktCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'object:TokenCodec:d0',
      'method:decodePayload:d1',
      'fun:String.toSlug:d0',
      'fun:withRetry:d0',
    ]);
  });
});

test('python: decorators, async def, class methods, and unindented multiline docstrings', () => {
  const pyCode = [
    '@cache',
    'async def fetch_manifest(url: str) -> dict:',
    '    """',
    'def fake_inside_docstring():',
    '    pass',
    '    """',
    '    return {"url": url}',
    '',
    'class WorkerPool:',
    '    def submit(self, job_id: str) -> bool:',
    '        return bool(job_id)',
  ].join('\n');

  withTempSkeleton('pool.py', pyCode, (res) => {
    const summary = res.items.map((it) => `${it.kind}:${it.name}:L${it.startLine}-L${it.endLine}:d${it.depth}`);
    assert.deepEqual(summary, [
      'def:fetch_manifest:L1-L7:d0',
      'class:WorkerPool:L9-L11:d0',
      'method:submit:L10-L11:d1',
    ]);
  });
});

test('go: grouped type declarations, structs/interfaces, functions, pointer receiver methods, and raw backticks', () => {
  const goCode = [
    'package store',
    '',
    'type (',
    '    Store struct {',
    '        root string',
    '    }',
    '    Reader interface {',
    '        Read(key string) (string, error)',
    '    }',
    ')',
    '',
    'func NewStore(root string) *Store {',
    '    raw := `func fakeInBacktick() {`',
    '    _ = raw',
    '    return &Store{root: root}',
    '}',
    '',
    'func (s *Store) Read(key string) (string, error) {',
    '    return s.root + key, nil',
    '}',
  ].join('\n');

  withTempSkeleton('store.go', goCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}`);
    assert.deepEqual(names, ['struct:Store', 'interface:Reader', 'func:NewStore', 'func:Read']);
  });
});

test('rust: struct, trait signatures, impl methods with lifetimes, raw strings, and macro_rules!', () => {
  const rsCode = [
    'pub struct SliceView<\'a> {',
    '    pub data: &\'a str,',
    '}',
    '',
    'pub trait Render {',
    '    fn render(&self) -> String;',
    '}',
    '',
    'impl<\'a> Render for SliceView<\'a> {',
    '    fn render(&self) -> String {',
    '        let raw = r#"{"unclosed_in_raw": true"#;',
    '        format!("{}:{}", self.data, raw)',
    '    }',
    '}',
    '',
    'macro_rules! ensure_non_empty {',
    '    ($x:expr) => { !$x.is_empty() };',
    '}',
  ].join('\n');

  withTempSkeleton('view.rs', rsCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'struct:SliceView:d0',
      'trait:Render:d0',
      'fn:render:d1',
      "impl:<'a> Render for SliceView<'a>:d0",
      'fn:render:d1',
      'macro:ensure_non_empty:d0',
    ]);
  });
});

test('markdown: extracts nested headings and ignores # comments inside fenced code blocks', () => {
  const mdCode = [
    '# Guide',
    '',
    '## Quickstart',
    '```bash',
    '# comment inside code block should not become a heading',
    'npx tokless skeleton .',
    '```',
    '',
    '## Architecture',
    '### Parser Core',
    'Details here.',
  ].join('\n');

  withTempSkeleton('GUIDE.md', mdCode, (res) => {
    const summary = res.items.map((it) => `${it.kind}:${it.name}:L${it.startLine}-L${it.endLine}:d${it.depth}`);
    assert.deepEqual(summary, [
      'heading:Guide:L1-L11:d0',
      'heading:Quickstart:L3-L7:d1',
      'heading:Architecture:L9-L11:d1',
      'heading:Parser Core:L10-L11:d2',
    ]);
  });
});
