import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import tasksHandler from './api/tasks.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'};

export function createLocalServer({apiHandler = tasksHandler} = {}) {
  return createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'http://localhost').pathname; }
    catch { res.statusCode = 400; return res.end('Bad request'); }
    if (pathname === '/api/tasks') return apiHandler(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const files = {'/': 'index.html', '/index.html': 'index.html', '/app.mjs': 'app.mjs'};
    const relative = files[pathname];
    if (!relative) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const file = path.join(root, relative);
    try {
      const contents = await readFile(file);
      res.statusCode = 200;
      res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
      res.setHeader('x-content-type-options', 'nosniff');
      return res.end(req.method === 'HEAD' ? undefined : contents);
    } catch {
      res.statusCode = 404;
      return res.end('Not found');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createLocalServer().listen(Number(process.env.PORT ?? 4101), '0.0.0.0');
}
