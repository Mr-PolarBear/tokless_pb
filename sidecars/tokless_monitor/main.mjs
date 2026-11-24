/**
 * Tokless Monitor — Antigravity 官方 Sidecar 后端
 * — 为什么这么写 —
 * 1. 基于 Antigravity 内置 sidecar_sdk 运行在独立本地 loopback 进程，0 模型 Token 底座税。
 * 2. 直接复用 tokless 零依赖 live-metrics.js 读取本地 conversations/<id>.db (Protobuf) 与 transcript_full.jsonl，
 *    实时返回当前会话的上下文水位、平均缓存率、TTFT、流式生成速度与思维链占比。
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const LIVE_METRICS_PATH = join(__dirname, '..', '..', 'tools', 'agy-audit', 'lib', 'live-metrics.js');
const PATHS_MOD_PATH = join(__dirname, '..', '..', 'tools', 'agy-audit', 'lib', 'paths.js');
let cachedMtimeMs = 0;
let cachedComputeFn = null;

/**
 * 为什么这么写：Sidecar 是常驻进程，若直接静态 require，覆盖安装插件后旧代码会一直驻留内存。
 * 按文件 mtimeMs 热重载，确保升级插件后无需重启客户端即可立即生效。
 */
function getComputeLiveSessionMetrics() {
  const mtimeMs = statSync(LIVE_METRICS_PATH).mtimeMs;
  if (!cachedComputeFn || mtimeMs !== cachedMtimeMs) {
    delete require.cache[require.resolve(PATHS_MOD_PATH)];
    delete require.cache[require.resolve(LIVE_METRICS_PATH)];
    cachedComputeFn = require(LIVE_METRICS_PATH).computeLiveSessionMetrics;
    cachedMtimeMs = mtimeMs;
  }
  return cachedComputeFn;
}

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
    const metrics = getComputeLiveSessionMetrics()(targetId);
    if (!metrics) {
      return { ok: false, error: '未找到可用会话日志，请先在会话中完成至少一轮对话。' };
    }
    return { ok: true, metrics };
  },
  'GET'
);

app.run().catch((err) => {
  console.error('[tokless-monitor] startup failed:', err);
  process.exit(1);
});
