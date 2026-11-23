/**
 * Tokless Monitor — Antigravity 官方 Sidecar 后端
 * — 为什么这么写 —
 * 1. 基于 Antigravity 内置 sidecar_sdk 运行在独立本地 loopback 进程，0 模型 Token 底座税。
 * 2. 直接复用 tokless 零依赖 live-metrics.js 读取本地 conversations/<id>.db (Protobuf) 与 transcript_full.jsonl，
 *    实时返回当前会话的上下文水位、平均缓存率、TTFT、流式生成速度与思维链占比。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { computeLiveSessionMetrics } = require(
  join(__dirname, '..', '..', 'tools', 'agy-audit', 'lib', 'live-metrics.js')
);
const { listSessions } = require(
  join(__dirname, '..', '..', 'tools', 'agy-audit', 'lib', 'paths.js')
);

const INDEX_HTML_PATH = join(__dirname, 'index.html');
const SAFE_ID_RE = /^[A-Za-z0-9._-]{4,128}$/;

const app = new SidecarApp();

app.page('/', () => {
  const html = readFileSync(INDEX_HTML_PATH, 'utf-8');
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: { 'Cache-Control': 'no-store' },
  });
});

app.api(
  '/api/metrics',
  (data) => {
    const rawId = typeof data?.conversationId === 'string' ? data.conversationId.trim() : '';
    const targetId =
      rawId && SAFE_ID_RE.test(rawId)
        ? rawId
        : app.config.conversationId || '';
    const metrics = computeLiveSessionMetrics(targetId);
    if (!metrics) {
      return { ok: false, error: '未找到可用会话日志，请先在会话中完成至少一轮对话。' };
    }
    return { ok: true, metrics };
  },
  'GET'
);

app.api(
  '/api/sessions',
  () => {
    const sessions = listSessions(10).map((s) => ({
      id: s.id,
      shortId: s.id.slice(0, 8),
      mtimeMs: s.mtimeMs,
    }));
    return { ok: true, sessions };
  },
  'GET'
);

app.run().catch((err) => {
  console.error('[tokless-monitor] startup failed:', err);
  process.exit(1);
});
