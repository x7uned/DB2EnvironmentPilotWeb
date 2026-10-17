const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

function reply(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', contentType);
  res.end(body);
}

function jsonError(res, status, message, extraHeaders = {}) {
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  reply(res, status, JSON.stringify({error: message}));
}

function upstreamUrl(apiUrl) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) throw new Error('invalid configuration');
  let base;
  try { base = new URL(apiUrl); } catch { throw new Error('invalid configuration'); }
  const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!localHttp && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('invalid configuration');
  }
  return new URL('/tasks', base.origin);
}

async function readPostBody(req) {
  const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('invalid request'), {status: 400});

  let raw;
  if (req.body !== undefined) {
    if (typeof req.body === 'string') raw = req.body;
    else {
      try { raw = JSON.stringify(req.body); } catch { throw Object.assign(new Error('invalid request'), {status: 400}); }
    }
  } else {
    const declaredLength = req.headers?.['content-length'];
    if (declaredLength !== undefined && (!/^\d+$/.test(String(declaredLength)) || Number(declaredLength) > MAX_BODY_BYTES)) {
      throw Object.assign(new Error('request too large'), {status: Number(declaredLength) > MAX_BODY_BYTES ? 413 : 400});
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request too large'), {status: 413});
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw Object.assign(new Error('request too large'), {status: 413});
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object');
    return raw;
  } catch {
    throw Object.assign(new Error('invalid request'), {status: 400});
  }
}

function isTimeout(error, signal) {
  return signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

export function createTasksHandler({env = process.env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  return async function tasksHandler(req, res) {
    const method = String(req.method ?? '').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      return jsonError(res, 405, 'Method not allowed', {allow: 'GET, POST'});
    }

    let endpoint;
    try { endpoint = upstreamUrl(env.API_URL); }
    catch { return jsonError(res, 500, 'Service configuration error'); }

    let body;
    if (method === 'POST') {
      try { body = await readPostBody(req); }
      catch (error) {
        const status = error.status === 413 ? 413 : 400;
        return jsonError(res, status, status === 413 ? 'Request too large' : 'Invalid request');
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(endpoint, {
        method,
        headers: method === 'POST' ? {'content-type': 'application/json'} : undefined,
        body: method === 'POST' ? body : undefined,
        redirect: 'error',
        signal: controller.signal,
      });
      const responseBody = Buffer.from(await upstream.arrayBuffer());
      res.statusCode = upstream.status;
      res.setHeader('cache-control', 'no-store');
      const upstreamContentType = upstream.headers?.get?.('content-type');
      if (upstreamContentType) res.setHeader('content-type', upstreamContentType);
      return res.end(responseBody);
    } catch (error) {
      if (isTimeout(error, controller.signal)) return jsonError(res, 504, 'Upstream request timed out');
      return jsonError(res, 502, 'Upstream service unavailable');
    } finally {
      clearTimeout(timer);
    }
  };
}

export default createTasksHandler();
