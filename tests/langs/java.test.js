'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateFileSkeleton } = require('../../tools/repo-skeleton/lib/skeleton');

function withJavaSkeleton(code, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-java-'));
  const filePath = path.join(dir, 'Sample.java');
  fs.writeFileSync(filePath, code, 'utf8');
  try {
    return fn(generateFileSkeleton(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('PR #2 regression: filters anonymous Runnable fields, preserves outer methods after nested static class, and handles dotted/generic/wildcard returns', () => {
  const javaCode = [
    'package com.example.demo;',
    '',
    'public class OrderService {',
    '    private final Runnable task = new Runnable() {',
    '        @Override',
    '        public void run() {',
    '            System.out.println("noop");',
    '        }',
    '    };',
    '',
    '    public Result.Obj<Resp.CreateOrder> createOrder(Req.CreateOrder req) {',
    '        return null;',
    '    }',
    '',
    '    private static class HelperItem {',
    '        private String id;',
    '        public String getId() {',
    '            return id;',
    '        }',
    '    }',
    '',
    '    public Map<String, Object> querySummary(String id)',
    '            throws java.io.IOException {',
    '        return null;',
    '    }',
    '',
    '    @Override public Result<?> cancelOrder(String id) {',
    '        return null;',
    '    }',
    '}',
  ].join('\n');

  withJavaSkeleton(javaCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);

    assert.ok(names.includes('class:OrderService:d0'), `missing outer class: ${names}`);
    assert.ok(names.includes('method:createOrder:d1'), `missing dotted generic method: ${names}`);
    assert.ok(names.includes('class:HelperItem:d1'), `missing nested static class: ${names}`);
    assert.ok(names.includes('method:getId:d2'), `missing nested class method: ${names}`);
    assert.ok(names.includes('method:querySummary:d1'), `missing method after inner class: ${names}`);
    assert.ok(names.includes('method:cancelOrder:d1'), `missing wildcard/inline-annotated method: ${names}`);
    assert.ok(!names.some((n) => n.includes('Runnable')), `anonymous field treated as callable: ${names}`);
    assert.ok(!names.some((n) => n.includes(':run:')), `anonymous inner run() leaked: ${names}`);
  });
});

test('Java 15+ multiline text blocks containing unbalanced braces and quotes do not swallow subsequent methods', () => {
  const javaCode = [
    'public class SqlRepository {',
    '    public String buildReportSql() {',
    '        String sql = """',
    '            SELECT payload->>\'{"unclosed_brace": true\' AS raw_json,',
    '                   "unbalanced \\" quote {" AS note',
    '            FROM orders -- { comment inside sql',
    '            WHERE status = \'PAID\'',
    '            """;',
    '        return sql;',
    '    }',
    '',
    '    public int countActiveOrders(long tenantId) {',
    '        return 42;',
    '    }',
    '}',
  ].join('\n');

  withJavaSkeleton(javaCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'class:SqlRepository:d0',
      'method:buildReportSql:d1',
      'method:countActiveOrders:d1',
    ]);
    const secondMethod = res.items.find((it) => it.name === 'countActiveOrders');
    assert.equal(secondMethod.startLine, 12);
    assert.equal(secondMethod.endLine, 14);
  });
});

test('nested annotation array braces/lambdas, return-type annotations, and intersection generics parse cleanly', () => {
  const javaCode = [
    'public class SecurityController {',
    '    @RequestMapping(path = {"/v1/items", "/v2/items"}, produces = {"application/json"})',
    '    @Auth(check = () -> true, roles = {"ADMIN", "AUDITOR"})',
    '    public @NotNull String inspectItem(@Valid ItemRequest req) {',
    '        return "ok";',
    '    }',
    '',
    '    public static <T extends Comparable<? super T> & java.io.Serializable> T pickMax(T left, T right) {',
    '        return left.compareTo(right) >= 0 ? left : right;',
    '    }',
    '}',
  ].join('\n');

  withJavaSkeleton(javaCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);
    assert.deepEqual(names, [
      'class:SecurityController:d0',
      'method:inspectItem:d1',
      'method:pickMax:d1',
    ]);
  });
});

test('supports @interface declarations, Java records with compact constructors, and enums with constant bodies', () => {
  const javaCode = [
    'public @interface AuditMeta {',
    '    String module() default "core";',
    '    int severity() default 1;',
    '}',
    '',
    'public record Money(long cents, String currency) {',
    '    public Money {',
    '        if (cents < 0) {',
    '            throw new IllegalArgumentException("negative");',
    '        }',
    '    }',
    '',
    '    public Money plus(Money other) {',
    '        return new Money(this.cents + other.cents, this.currency);',
    '    }',
    '}',
    '',
    'public enum OrderState {',
    '    PENDING {',
    '        @Override',
    '        public boolean isFinal() {',
    '            return false;',
    '        }',
    '    },',
    '    COMPLETED {',
    '        @Override',
    '        public boolean isFinal() {',
    '            return true;',
    '        }',
    '    };',
    '',
    '    public abstract boolean isFinal();',
    '',
    '    public String displayCode() {',
    '        return name().toLowerCase();',
    '    }',
    '}',
  ].join('\n');

  withJavaSkeleton(javaCode, (res) => {
    const names = res.items.map((it) => `${it.kind}:${it.name}:d${it.depth}`);

    assert.ok(names.includes('@interface:AuditMeta:d0'), `missing @interface: ${names}`);
    assert.ok(names.includes('method:module:d1'), `missing @interface element module(): ${names}`);
    assert.ok(names.includes('method:severity:d1'), `missing @interface element severity(): ${names}`);

    assert.ok(names.includes('record:Money:d0'), `missing record Money: ${names}`);
    assert.ok(names.includes('method:Money:d1'), `missing compact record constructor: ${names}`);
    assert.ok(names.includes('method:plus:d1'), `missing record method plus(): ${names}`);

    assert.ok(names.includes('enum:OrderState:d0'), `missing enum OrderState: ${names}`);
    assert.ok(names.includes('method:displayCode:d1'), `missing enum method displayCode(): ${names}`);
    assert.ok(!names.includes('method:isFinal:d2'), `enum constant override leaked as method: ${names}`);
  });
});
