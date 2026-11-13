import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];
export const DEEPSEEK_API = 'https://api.deepseek.com';

export function validKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096 || /\s|\p{Cc}/u.test(value)) {
    throw new Error('请填写有效的 DeepSeek API Key，省略空格和换行。');
  }
  return value;
}

function allowedOrigins(extra) {
  const origins = new Set([DEEPSEEK_API]);
  for (const raw of String(extra ?? '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('模型出口只接受 https 地址。');
    origins.add(url.origin);
  }
  return origins;
}

function baseURL(value, extra) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !((allowedOrigins(extra).has(url.origin) && ['/', '/v1', '/v1/'].includes(url.pathname)) ||
        (url.protocol === 'http:' && url.hostname === '127.0.0.1' && ['/', '/v1', '/v1/'].includes(url.pathname)))) {
    throw new Error('模型出口必须是 DeepSeek 官方 API、允许的内网网关或本机测试服务。');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export async function validateKey(key, { upstream = DEEPSEEK_API, upstreamAllowlist } = {}) {
  validKey(key);
  let response;
  try {
    response = await fetch(`${baseURL(upstream, upstreamAllowlist)}/models`, {
      headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error('无法连接模型出口，请检查网络后重试。'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 ? '模型出口未接受这个 Key，请核对后重试。' : `模型列表返回 HTTP ${response.status}。`);
  }
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.data) || !payload.data.some(model => MODELS.includes(model?.id))) {
    throw new Error('此 Key 的模型列表未包含当前支持的 DeepSeek 模型。');
  }
}

export async function startRelay({ key, upstream = DEEPSEEK_API, upstreamAllowlist }) {
  validKey(key);
  upstream = baseURL(upstream, upstreamAllowlist);
  const token = randomBytes(32).toString('hex');
  const active = new Set();
  const server = createServer(async (request, response) => {
    const fail = (status, message) => {
      if (response.headersSent) return response.destroy();
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { message } }));
    };
    if (request.headers.authorization !== `Bearer ${token}`) return fail(401, '本机模型入口凭据无效。');
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return response.end(JSON.stringify({ object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) }));
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') return fail(404, '模型接口不在本机允许范围内。');
    if (active.size >= 8) return fail(429, '并发模型请求较多，请稍后重试。');
    const abort = new AbortController();
    active.add(abort);
    response.once('close', () => abort.abort());
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) return fail(413, '本机模型请求超过 64 MiB。');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks)); }
      catch { return fail(400, '模型请求需要有效 JSON。'); }
      if (!body || Array.isArray(body) || !MODELS.includes(body.model)) return fail(403, '此部署只启用指定的 DeepSeek 模型。');
      body.store = false;
      const upstreamResponse = await fetch(`${upstream}/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(600_000)]),
      });
      if (!upstreamResponse.ok) {
        await upstreamResponse.body?.cancel();
        return fail(upstreamResponse.status, `模型出口返回 HTTP ${upstreamResponse.status}，请检查 Key、额度或模型配置。`);
      }
      if (!upstreamResponse.body) return fail(502, '模型出口返回空响应。');
      response.writeHead(upstreamResponse.status, {
        'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store',
      });
      await pipeline(Readable.fromWeb(upstreamResponse.body), response);
    } catch {
      if (!abort.signal.aborted) fail(502, '模型出口连接失败或响应超时，请检查网络后重试。');
    } finally { active.delete(abort); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, token,
    async close() {
      for (const request of active) request.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}