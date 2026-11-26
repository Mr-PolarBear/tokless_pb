'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateFileSkeleton } = require('../../tools/repo-skeleton/lib/skeleton');
const { getLanguageDir } = require('../../tools/repo-skeleton/lib/core/registry');

function withTempSkeleton(fileName, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-js-'));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    return fn(generateFileSkeleton(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('routes .js/.mjs/.cjs/.jsx/.ts/.tsx to langs/javascript and parses module/JSX exports', () => {
  for (const ext of ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']) {
    assert.equal(getLanguageDir(ext), 'javascript');
  }

  withTempSkeleton(
    'helper.cjs',
    [
      'exports.parseFlag = (raw) => Boolean(raw);',
      'function normalizePort(p) {',
      '  return Number(p) || 8080;',
      '}',
      'module.exports = { normalizePort };',
    ].join('\n'),
    (res) => {
      const names = res.items.map((it) => `${it.kind}:${it.name}`);
      assert.deepEqual(names, ['function:parseFlag', 'function:normalizePort', 'export:module.exports']);
    }
  );

  withTempSkeleton(
    'Card.tsx',
    [
      'export interface CardProps {',
      '  title: string;',
      '}',
      'export const ActionCard = ({ title }: CardProps) => {',
      '  return <section>{title}</section>;',
      '};',
    ].join('\n'),
    (res) => {
      const names = res.items.map((it) => `${it.kind}:${it.name}`);
      assert.deepEqual(names, ['interface:CardProps', 'function:ActionCard']);
    }
  );
});

test('PR #2 regression: extracts declarations inside top-level IIFE and UMD wrappers while keeping plain top-level functions intact', () => {
  const iifeJs = [
    '(function (global) {',
    "  'use strict';",
    '',
    '  function apiBase() {',
    '    return "";',
    '  }',
    '',
    '  async function postJson(url, payload) {',
    '    return fetch(url, { body: JSON.stringify(payload) });',
    '  }',
    '',
    '  const formatName = (name) => {',
    '    return String(name || "").trim();',
    '  };',
    '',
    '  class LocalCache {',
    '    get(key) {',
    '      return key;',
    '    }',
    '  }',
    '',
    '  global.Demo = { apiBase, postJson, formatName, LocalCache };',
    '})(window);',
  ].join('\n');

  withTempSkeleton('legacy-common.js', iifeJs, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}`);
    assert.ok(names.includes('function:apiBase'), `missing apiBase: ${names}`);
    assert.ok(names.includes('function:postJson'), `missing postJson: ${names}`);
    assert.ok(names.includes('function:formatName'), `missing formatName: ${names}`);
    assert.ok(names.includes('class:LocalCache'), `missing LocalCache: ${names}`);
    assert.ok(names.includes('method:get'), `missing LocalCache.get: ${names}`);
  });

  const arrowIifeJs = [
    '(() => {',
    '  function initWidget() {',
    '    return 1;',
    '  }',
    '})();',
    '',
    'export function standaloneHelper() {',
    '  return 2;',
    '}',
  ].join('\n');

  withTempSkeleton('arrow-iife.mjs', arrowIifeJs, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}`);
    assert.deepEqual(names, ['function:initWidget', 'function:standaloneHelper']);
  });
});

test('TypeScript interface, type, enum, abstract class, and arrow class fields parse accurately', () => {
  const tsCode = [
    'export interface TaskOptions {',
    '  retries: number;',
    '}',
    '',
    'export type TaskOutcome<T> = { ok: true; data: T } | { ok: false; error: string };',
    '',
    'export const enum TaskPriority {',
    '  Low = 0,',
    '  High = 1,',
    '}',
    '',
    'export abstract class BaseRunner {',
    '  private count: number = 0;',
    '  abstract execute(opts: TaskOptions): Promise<void>;',
    '  private onTick = async (): Promise<number> => {',
    '    return 1;',
    '  };',
    '}',
  ].join('\n');

  withTempSkeleton('runner.ts', tsCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'interface:TaskOptions:d0',
      'type:TaskOutcome:d0',
      'enum:TaskPriority:d0',
      'class:BaseRunner:d0',
      'method:execute:d1',
      'method:onTick:d1',
    ]);
  });
});

test('Vue SFC (.vue) delegates <script lang="ts"> to javascript parser with shifted line offsets', () => {
  assert.equal(getLanguageDir('.vue'), 'sfc');
  assert.equal(getLanguageDir('.svelte'), 'sfc');

  const vueCode = [
    '<template>',
    '  <div class="panel">{{ count }}</div>',
    '</template>',
    '',
    '<script setup lang="ts">',
    'interface PanelState {',
    '  count: number;',
    '}',
    'function increment(step = 1): number {',
    '  return step + 1;',
    '}',
    '</script>',
    '',
    '<style scoped>',
    '.panel { padding: 8px; }',
    '</style>',
  ].join('\n');

  withTempSkeleton('Panel.vue', vueCode, (res) => {
    const summary = res.items.map((it) => `${it.kind}:${it.name}:L${it.startLine}-L${it.endLine}:d${it.depth}`);
    assert.deepEqual(summary, [
      'section:template:L1-L3:d0',
      'section:script:L5-L12:d0',
      'interface:PanelState:L6-L8:d1',
      'function:increment:L9-L11:d1',
      'section:style:L14-L16:d0',
    ]);
  });
});

test('extracts top-level and nested describe/test/it blocks with [Lstart-Lend] ranges while ignoring non-block calls', () => {
  const testSuiteCode = [
    'function buildFixture() {',
    '  return { ready: true };',
    '}',
    '',
    'test.todo("pending feature without block");',
    '',
    'describe("AuthService", () => {',
    '  function makeToken() {',
    '    return "tok";',
    '  }',
    '',
    '  it("signs payload cleanly", () => {',
    '    const tok = makeToken();',
    '    return Boolean(tok);',
    '  });',
    '',
    '  describe.only("expiration", function () {',
    '    test(',
    '      "rejects expired token",',
    '      { timeout: 1000 },',
    '      async () => {',
    '        return buildFixture();',
    '      }',
    '    );',
    '  });',
    '});',
  ].join('\n');

  withTempSkeleton('auth.test.js', testSuiteCode, (res) => {
    const summary = res.items.map(
      (it) => `${it.kind}:${it.signature}:L${it.startLine}-L${it.endLine}:d${it.depth}`
    );
    assert.deepEqual(summary, [
      'function:function buildFixture():L1-L3:d0',
      'suite:describe("AuthService"):L7-L26:d0',
      'function:function makeToken():L8-L10:d1',
      'test:it("signs payload cleanly"):L12-L15:d1',
      'suite:describe.only("expiration"):L17-L25:d1',
      'test:test("rejects expired token"):L18-L24:d2',
    ]);
  });
});
