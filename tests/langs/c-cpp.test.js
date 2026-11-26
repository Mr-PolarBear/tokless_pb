'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKELETON_LIB = path.join(REPO_ROOT, 'tools', 'repo-skeleton', 'lib', 'skeleton.js');
const { generateFileSkeleton, scanDirectorySkeleton } = require(SKELETON_LIB);

function withTempFile(filename, content, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-ccpp-'));
  try {
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return fn(filePath, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('c-cpp: extracts pointer-returning functions, multiline signatures, and attributes', () => {
  const code = `
#include <stdint.h>

static const uint8_t *
__attribute__((used, section(".fast_code")))
get_dma_buffer(uint32_t channel,
               size_t *out_len)
{
    if (channel > 4) {
        return NULL;
    }
    *out_len = 64;
    return (const uint8_t *)0x20000000;
}

struct Node *find_node(int id)
{
    return 0;
}

__STATIC_INLINE void __weak hal_tick_inc(void)
{
    return;
}
`.trimStart();

  withTempFile('driver.c', code, (filePath) => {
    const res = generateFileSkeleton(filePath);
    const names = res.items.map((x) => `${x.kind}:${x.name}`);
    assert.deepEqual(names, ['function:get_dma_buffer', 'function:find_node', 'function:hal_tick_inc']);
    assert.equal(res.items[0].startLine, 3);
    assert.equal(res.items[0].endLine, 13);
    assert.equal(res.items[1].startLine, 15);
    assert.equal(res.items[1].endLine, 18);
  });
});

test('c-cpp: extracts header prototypes, typedef struct/union/enum, fn pointers, and extern "C"', () => {
  const header = `
#ifndef CAN_DRIVER_H
#define CAN_DRIVER_H

#ifdef __cplusplus
extern "C" {
#endif

typedef uint32_t can_id_t;

typedef struct CanFrame {
    uint32_t id;
    uint8_t dlc;
    uint8_t data[8];
} CanFrame_t, *PCanFrame_t;

typedef struct {
    int (*init)(void *ctx);
    void (*deinit)(void *ctx);
} CanDriverOps_t;

typedef union {
    uint32_t word;
    uint8_t bytes[4];
} CanWord_u;

typedef enum {
    CAN_OK = 0,
    CAN_ERR = -1
} CanStatus_e;

typedef void (*can_rx_cb_t)(const CanFrame_t *frame, void *user_data);

struct ForwardOpaque;

int *can_get_tx_mailbox(uint8_t bus, uint32_t timeout_ms);
CanStatus_e can_send_frame(
    uint8_t bus,
    const CanFrame_t *frame
);
void (*can_set_hook(int irq, void (*fn)(int)))(int);

EXPORT_SYMBOL(can_send_frame);

#ifdef __cplusplus
}
#endif

#endif
`.trimStart();

  withTempFile('can_driver.h', header, (filePath) => {
    const res = generateFileSkeleton(filePath);
    const items = res.items;
    const names = items.map((x) => `${x.kind}:${x.name}`);

    assert.equal(names.includes('macro:CAN_DRIVER_H'), false);
    assert.equal(names.includes('struct:ForwardOpaque'), false);
    assert.equal(names.includes('function:EXPORT_SYMBOL'), false);
    assert.equal(names.includes('method:init'), false);
    assert.equal(names.includes('function:init'), false);

    assert.deepEqual(names, [
      'typedef:can_id_t',
      'typedef:CanFrame_t',
      'typedef:CanDriverOps_t',
      'typedef:CanWord_u',
      'typedef:CanStatus_e',
      'typedef:can_rx_cb_t',
      'function:can_get_tx_mailbox',
      'function:can_send_frame',
      'function:can_set_hook',
    ]);

    for (const item of items) {
      assert.equal(item.depth, 0, `extern "C" child ${item.name} should stay at depth 0`);
    }
    const frameItem = items.find((i) => i.name === 'CanFrame_t');
    assert.match(frameItem.signature, /CanFrame_t/);
  });
});

test('c-cpp: handles #if/#else/#endif brace branches and #if 0 dead code without brace drift', () => {
  const code = `
#if 0
void broken_dead_code(void) {
    if (1) {
        // unclosed brace inside #if 0!
#endif

#ifdef USE_DMA
void transfer_data(int len) {
#else
void transfer_data(int len) {
    len = len + 1;
#endif
    for (int i = 0; i < len; i++) {
    }
}

void after_ifdef_func(void) {
    return;
}
`.trimStart();

  withTempFile('cond.c', code, (filePath) => {
    const res = generateFileSkeleton(filePath);
    const names = res.items.map((x) => x.name);
    assert.equal(names.includes('broken_dead_code'), false);
    assert.ok(names.includes('after_ifdef_func'));
    const afterItem = res.items.find((x) => x.name === 'after_ifdef_func');
    assert.equal(afterItem.depth, 0);
    assert.equal(afterItem.startLine, 17);
    assert.equal(afterItem.endLine, 19);
  });
});

test('c-cpp: extracts function-like and multiline #define macros and folds constant macro blocks', () => {
  const lines = [
    '#ifndef REG_MAP_H',
    '#define REG_MAP_H',
    '',
    '#define BIT(n) (1U << (n))',
    '#define WRITE_PAIR(a, b) do { \\',
    '    reg_a = (a); \\',
    '    reg_b = (b); \\',
    '} while (0)',
    '',
  ];
  for (let i = 0; i < 18; i++) {
    lines.push(`#define REG_ADDR_${i} (0x40000000U + ${i * 4}U)`);
  }
  lines.push('');
  lines.push('void reg_init(void);');
  lines.push('#endif');

  withTempFile('reg_map.h', lines.join('\n'), (filePath) => {
    const res = generateFileSkeleton(filePath);
    const macros = res.items.filter((x) => x.kind === 'macro');
    assert.equal(macros.some((m) => m.name === 'REG_MAP_H'), false);
    assert.equal(macros.some((m) => m.name === 'BIT'), true);
    const multi = macros.find((m) => m.name === 'WRITE_PAIR');
    assert.ok(multi);
    assert.equal(multi.startLine, 5);
    assert.equal(multi.endLine, 8);

    const folded = macros.find((m) =>
      /18 macros: REG_ADDR_0, REG_ADDR_1, \.\.\., REG_ADDR_17/.test(m.signature)
    );
    assert.ok(folded, `expected folded macro group, got: ${JSON.stringify(macros)}`);
    assert.equal(res.items.some((x) => x.kind === 'function' && x.name === 'reg_init'), true);
  });
});

test('c-cpp: extracts large static lookup table initializers as var', () => {
  const code = `
static const uint16_t crc16_table[8] = {
    0x0000, 0x1021,
    0x2042, 0x3063,
    0x4084, 0x50A5
};

static int small_val = 42;

uint16_t calc_crc(const uint8_t *buf) {
    return crc16_table[buf[0] & 7];
}
`.trimStart();

  withTempFile('crc.c', code, (filePath) => {
    const res = generateFileSkeleton(filePath);
    const names = res.items.map((x) => `${x.kind}:${x.name}`);
    assert.deepEqual(names, ['var:crc16_table', 'function:calc_crc']);
    assert.equal(res.items[0].startLine, 1);
    assert.equal(res.items[0].endLine, 5);
  });
});

test('c-cpp: handles C++ namespace, class, ctor initializer braces, raw strings, digit separators, operator()', () => {
  const cpp = `
namespace io::detail {

class RingBuffer {
public:
    explicit RingBuffer(int cap);
    ~RingBuffer();

    RingBuffer(int cap, int init)
        : m_cap{cap}
        , m_head{init}
    {
        auto raw = R"delim(
            class FakeClass { void fake_fn() {} };
        )delim";
        int million = 1'000'000;
        unsigned long long magic_arr[] = { 0xDEAD'BEEF'CAFEULL, 0b1010'0101'1111ULL };
        char ch = u8'a';
        (void)raw;
        (void)million;
        (void)magic_arr;
        (void)ch;
    }

    bool operator()(int idx) const {
        return idx < m_cap;
    }
};

} // namespace io::detail
`.trimStart();

  withTempFile('ring_buffer.hpp', cpp, (filePath) => {
    const res = generateFileSkeleton(filePath);
    const summary = res.items.map((x) => `${x.depth}:${x.kind}:${x.name}`);
    assert.deepEqual(summary, [
      '0:namespace:io::detail',
      '1:class:RingBuffer',
      '2:method:RingBuffer',
      '2:method:~RingBuffer',
      '2:method:RingBuffer',
      '2:method:operator()',
    ]);
    const ctorDef = res.items[4];
    assert.equal(ctorDef.startLine, 8);
    assert.equal(ctorDef.endLine, 22);
    assert.equal(res.items.some((x) => x.name === 'FakeClass' || x.name === 'fake_fn'), false);
  });
});

test('c-cpp: scanDirectorySkeleton ignores Objects, Listings, .clangd, cmake-build-* and custom --exclude', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-ccpp-dir-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'Objects'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'Listings'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.clangd'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'cmake-build-debug'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'third_party'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'main.c'), 'int main(void) { return 0; }\n');
    fs.writeFileSync(path.join(tmpDir, 'Objects', 'main.c'), 'void obj_fn(void) {}\n');
    fs.writeFileSync(path.join(tmpDir, 'Listings', 'main.c'), 'void lst_fn(void) {}\n');
    fs.writeFileSync(path.join(tmpDir, '.clangd', 'idx.c'), 'void cl_fn(void) {}\n');
    fs.writeFileSync(path.join(tmpDir, 'cmake-build-debug', 'gen.c'), 'void cm_fn(void) {}\n');
    fs.writeFileSync(path.join(tmpDir, 'third_party', 'ext.c'), 'void tp_fn(void) {}\n');

    const res = scanDirectorySkeleton(tmpDir, { depth: 3, exclude: ['third_party'] });
    assert.deepEqual(
      res.files.map((f) => f.relPath),
      ['src/main.c']
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('c-cpp: scanning .c and .h files lazily loads only langs/c-family', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokless-ccpp-lazy-'));
  try {
    const hFile = path.join(tmpDir, 'drv.h');
    const cFile = path.join(tmpDir, 'drv.c');
    fs.writeFileSync(hFile, 'int drv_init(void);\n');
    fs.writeFileSync(cFile, 'int drv_init(void) { return 0; }\n');

    const probe = `
      const skel = require(${JSON.stringify(SKELETON_LIB)});
      skel.generateFileSkeleton(${JSON.stringify(hFile)});
      skel.generateFileSkeleton(${JSON.stringify(cFile)});
      const loaded = Object.keys(require.cache)
        .map((p) => p.replace(/\\\\/g, '/'))
        .map((p) => p.match(/\\/tools\\/repo-skeleton\\/lib\\/langs\\/([^/]+)\\//))
        .filter(Boolean)
        .map((m) => m[1]);
      process.stdout.write(JSON.stringify([...new Set(loaded)].sort()));
    `;
    const res = spawnSync(process.execPath, ['-e', probe], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), ['c-family']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
