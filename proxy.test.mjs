import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createTasksHandler} from './api/tasks.mjs';
import {createLocalServer} from './server.mjs';

function request(method, {headers = {}, body, url = '/api/tasks?ignored=1'} = {}) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, {method, headers, url});
  return req;
}

function response() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); this.finished = true; },
  };
}

async function invoke(handler, req) {
  const res = response();
  await handler(req, res);
  return res;
}

test('GET forwards to the fixed tasks endpoint and preserves upstream response', async () => {
  let seen;
  const handler = createTasksHandler({env: {API_URL: 'https://gateway.example'}, fetchImpl: async (url, options) => {
    seen = {url: String(url), options};
    return new Response('{"tasks":[]}', {status: 206, headers: {'content-type': 'application/json; charset=utf-8'}});
  }});
  const res = await invoke(handler, request('GET', {headers: {authorization: 'Bearer secret', cookie: 'private'}}));
  assert.equal(seen.url, 'https://gateway.example/tasks');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.headers, undefined);
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.body.toString(), '{"tasks":[]}');
});

test('POST forwards JSON while excluding caller headers and preserves backend errors', async () => {
  let seen;
  const handler = createTasksHandler({env: {API_URL: 'https://gateway.example'}, fetchImpl: async (url, options) => {
    seen = {url: String(url), options};
    return new Response('{"error":"duplicate"}', {status: 409, headers: {'content-type': 'application/problem+json'}});
  }});
  const res = await invoke(handler, request('POST', {
    headers: {'content-type': 'application/json', authorization: 'Bearer secret', 'x-forwarded-for': '127.0.0.1'},
    body: {title: 'Write docs', priority: 'normal'},
  }));
  assert.equal(seen.url, 'https://gateway.example/tasks');
  assert.equal(seen.options.body, '{"title":"Write docs","priority":"normal"}');
  assert.deepEqual(seen.options.headers, {'content-type': 'application/json'});
  assert.equal(res.statusCode, 409);
  assert.equal(res.headers['content-type'], 'application/problem+json');
  assert.equal(res.body.toString(), '{"error":"duplicate"}');
});

test('missing, insecure, credentialed, or path-bearing API_URL returns generic configuration error', async () => {
  for (const API_URL of [undefined, '', 'http://gateway.example', 'https://user:pass@gateway.example', 'https://gateway.example/private']) {
    const handler = createTasksHandler({env: {API_URL}, fetchImpl: async () => { throw new Error('must not fetch'); }});
    const res = await invoke(handler, request('GET'));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.toString(), '{"error":"Service configuration error"}');
    if (typeof API_URL === 'string' && API_URL.length > 0) assert.equal(res.body.toString().includes(API_URL), false);
  }
});

test('POST accepts the parsed body shape provided by Vercel', async () => {
  let seenBody;
  const handler = createTasksHandler({env: {API_URL: 'https://gateway.example'}, fetchImpl: async (_url, options) => {
    seenBody = options.body;
    return new Response('{"id":1}', {status: 201, headers: {'content-type': 'application/json'}});
  }});
  const req = request('POST', {headers: {'content-type': 'application/json'}});
  req.body = {title: 'Parsed request'};
  const res = await invoke(handler, req);
  assert.equal(seenBody, '{"title":"Parsed request"}');
  assert.equal(res.statusCode, 201);
});

test('unsupported methods and malformed or oversized POST requests are rejected', async () => {
  let calls = 0;
  const handler = createTasksHandler({env: {API_URL: 'https://gateway.example'}, fetchImpl: async () => { calls++; return new Response('ok'); }});
  const methodRes = await invoke(handler, request('PUT'));
  assert.equal(methodRes.statusCode, 405);
  assert.equal(methodRes.headers.allow, 'GET, POST');
  const malformedRes = await invoke(handler, request('POST', {headers: {'content-type': 'application/json'}, body: '{bad'}));
  assert.equal(malformedRes.statusCode, 400);
  const mediaTypeRes = await invoke(handler, request('POST', {headers: {'content-type': 'text/plain'}, body: 'hi'}));
  assert.equal(mediaTypeRes.statusCode, 400);
  const oversized = 'x'.repeat(1024 * 1024 + 1);
  const oversizedRes = await invoke(handler, request('POST', {headers: {'content-type': 'application/json'}, body: oversized}));
  assert.equal(oversizedRes.statusCode, 413);
  assert.equal(calls, 0);
});

test('upstream redirects and failures are sanitized, and timeouts return 504', async () => {
  const redirectHandler = createTasksHandler({env: {API_URL: 'https://gateway.example'}, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    throw new TypeError('redirect disallowed');
  }});
  const failed = await invoke(redirectHandler, request('GET'));
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.toString(), '{"error":"Upstream service unavailable"}');

  const timeoutHandler = createTasksHandler({env: {API_URL: 'https://gateway.example'}, timeoutMs: 10, fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), {once: true});
  })});
  const timedOut = await invoke(timeoutHandler, request('GET'));
  assert.equal(timedOut.statusCode, 504);
  assert.equal(timedOut.body.toString(), '{"error":"Upstream request timed out"}');
});

test('local server exposes only static entry files and the proxy route', async t => {
  const server = createLocalServer({apiHandler: async (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{"tasks":[]}');
  }});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const pathname of ['/.env', '/api/tasks.mjs', '/package.json', '/%2eenv', '/%2e%2e/package.json']) {
    const res = await fetch(`${base}${pathname}`);
    assert.equal(res.status, 404, pathname);
  }
  const root = await fetch(`${base}/?x=1`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /^text\/html/);
  const api = await fetch(`${base}/api/tasks`);
  assert.equal(api.status, 200);
  assert.equal(await api.text(), '{"tasks":[]}');
});
