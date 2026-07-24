#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const host = '127.0.0.1';
const port = 18130;
const apiHost = '127.0.0.1';
const apiPort = 18120;
const distRoot = path.resolve(__dirname, '../../app/frontend/dist');
const indexFile = path.join(distRoot, 'index.html');

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
]);

function json(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function proxyApi(request, response) {
  const headers = { ...request.headers };
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers.upgrade;
  headers.host = `${apiHost}:${apiPort}`;
  headers['x-forwarded-host'] = request.headers.host || `127.0.0.1:${port}`;
  headers['x-forwarded-proto'] = 'https';

  const upstream = http.request({
    host: apiHost,
    port: apiPort,
    method: request.method,
    path: request.url,
    headers,
    timeout: 30_000
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders.connection;
    delete responseHeaders['transfer-encoding'];
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('API proxy timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) json(response, 502, { status: 'unavailable', service: 'v2-test-api' });
    else response.destroy();
  });
  request.pipe(upstream);
}

function safeStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const normalized = path.posix.normalize(`/${decoded}`).replace(/^\/+/, '');
  const candidate = path.resolve(distRoot, ...normalized.split('/'));
  return candidate === distRoot || candidate.startsWith(`${distRoot}${path.sep}`)
    ? candidate
    : null;
}

function serveFile(request, response, file) {
  let stats;
  try {
    stats = fs.statSync(file);
  } catch {
    json(response, 404, { status: 'not_found' });
    return;
  }
  if (!stats.isFile()) {
    json(response, 404, { status: 'not_found' });
    return;
  }
  const extension = path.extname(file).toLowerCase();
  const cacheControl = file === indexFile
    ? 'no-store'
    : file.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300';
  response.writeHead(200, {
    'cache-control': cacheControl,
    'content-length': stats.size,
    'content-type': mimeTypes.get(extension) || 'application/octet-stream',
    'x-content-type-options': 'nosniff'
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(file).pipe(response);
}

if (!fs.statSync(indexFile).isFile()) throw new Error(`Web build is missing: ${indexFile}`);

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/health') {
    json(response, 200, { status: 'healthy', service: 'task-distribution-v2-test-web' });
    return;
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    proxyApi(request, response);
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    json(response, 405, { status: 'method_not_allowed' });
    return;
  }
  const candidate = safeStaticPath(url.pathname);
  if (!candidate) {
    json(response, 400, { status: 'bad_request' });
    return;
  }
  let selected = candidate;
  try {
    if (!fs.statSync(selected).isFile()) selected = indexFile;
  } catch {
    selected = path.extname(url.pathname) ? candidate : indexFile;
  }
  serveFile(request, response, selected);
});

server.headersTimeout = 35_000;
server.requestTimeout = 30_000;
server.listen(port, host, () => {
  process.stdout.write(`V2 test Web listening on http://${host}:${port}\n`);
});

function shutdown(signal) {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
  process.stdout.write(`Received ${signal}; stopping V2 test Web\n`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
