import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'
]);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const err = new Error('request body exceeds limit of ' + limit + ' bytes');
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function pickUpstream(upstreams, pathname) {
  for (const up of upstreams) {
    for (const prefix of up.match || []) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        return { upstream: up, prefix };
      }
    }
  }
  return { upstream: null, prefix: null };
}

/**
 * Forwards to the upstream origin while keeping the upstream's own path prefix intact.
 *
 * TeleAgent signs requests against the URL it was configured with, so the bridge must not
 * silently add or drop path segments: a hooked client that already speaks the canonical path
 * (/superCowork/sapi/api/v1/...) is forwarded byte-identically, and a client that only speaks
 * /api/v1/... gets the upstream prefix prepended.
 */
export function buildTargetUrl(upstream, pathname, search, prefix) {
  const base = upstream.baseUrl.replace(/\/+$/, '');
  const u = new URL(base);
  const origin = u.origin;
  const basePath = u.pathname.replace(/\/+$/, '');
  const tail = (search || '');
  if (basePath && (pathname === basePath || pathname.startsWith(basePath + '/'))) {
    return origin + pathname + tail;
  }
  let rest = pathname;
  if (prefix && rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  if (!rest.startsWith('/')) rest = '/' + rest;
  const apiIdx = rest.startsWith('/api/v1') ? rest.slice('/api/v1'.length) : null;
  if (apiIdx !== null && basePath.endsWith('/api/v1')) {
    return origin + basePath + apiIdx + tail;
  }
  return origin + basePath + rest + tail;
}

export function guessModel(buffer) {
  if (!buffer || buffer.length === 0 || buffer.length > 2 * 1024 * 1024) return null;
  const m = /"model"\s*:\s*"([^"]{1,200})"/.exec(buffer.toString('utf8'));
  return m ? m[1] : null;
}

export function applyModelAlias(buffer, aliases) {
  if (!aliases || Object.keys(aliases).length === 0) {
    return { buffer, model: guessModel(buffer), changed: false };
  }
  if (!buffer || buffer.length === 0) return { buffer, model: null, changed: false };
  let obj;
  try {
    obj = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { buffer, model: null, changed: false };
  }
  if (!obj || typeof obj !== 'object') return { buffer, model: null, changed: false };
  const original = obj.model;
  const mapped = typeof original === 'string' ? aliases[original] : undefined;
  if (!mapped || mapped === original) {
    return { buffer, model: typeof original === 'string' ? original : null, changed: false };
  }
  obj.model = mapped;
  return { buffer: Buffer.from(JSON.stringify(obj), 'utf8'), model: mapped, changed: true, original };
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function requestOnce({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers,
        agent: isHttps ? httpsAgent : httpAgent
      },
      (res) => resolve({ req, res })
    );
    req.setTimeout(timeoutMs || 300000, () => {
      const err = new Error('upstream timeout after ' + (timeoutMs || 300000) + 'ms');
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    if (body && body.length) req.end(body);
    else req.end();
  });
}

function shouldFailover(status, cfg) {
  if (!cfg?.enabled) return false;
  return (cfg.onStatusCode || []).includes(status);
}

export async function forward({ req, res, cfg, upstreamOrder, pathname, search, body, logger, captureCtx }) {
  const attempts = [];
  let lastError = null;
  for (let i = 0; i < upstreamOrder.length; i += 1) {
    const upstream = upstreamOrder[i];
    const targetUrl = buildTargetUrl(upstream, pathname, search, upstream.prefix);
    const headers = { ...filterHeaders(req.headers) };
    for (const [k, v] of Object.entries(upstream.headers || {})) headers[k] = v;
    if (body && body.length) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    const startedAt = Date.now();
    let upstreamReq;
    try {
      const { res: upstreamRes } = await requestOnce({
        url: targetUrl,
        method: req.method,
        headers,
        body,
        timeoutMs: upstream.timeoutMs
      });
      const status = upstreamRes.statusCode || 502;
      const failover = shouldFailover(status, cfg.failover) && i < upstreamOrder.length - 1;
      if (failover) {
        // Drain and retry on the next upstream.
        const drained = [];
        await new Promise((resolve) => {
          upstreamRes.on('data', (c) => drained.push(c));
          upstreamRes.on('end', resolve);
          upstreamRes.on('error', resolve);
        });
        attempts.push({ upstream: upstream.name, status, url: targetUrl });
        lastError = new Error('upstream ' + upstream.name + ' returned ' + status);
        continue;
      }

      const outHeaders = filterHeaders(upstreamRes.headers);
      res.writeHead(status, outHeaders);

      const chunks = [];
      let captured = 0;
      const cap = cfg.capture?.maxBodyBytes ?? 4 * 1024 * 1024;
      upstreamRes.on('data', (chunk) => {
        res.write(chunk);
        if (captureCtx && captured < cap) {
          chunks.push(chunk);
          captured += chunk.length;
        }
      });
      await new Promise((resolve, reject) => {
        upstreamRes.on('end', resolve);
        upstreamRes.on('error', reject);
        res.on('close', resolve);
      });
      res.end();

      const contentType = String(upstreamRes.headers['content-type'] || '');
      captureCtx?.done?.({
        upstream: upstream.name,
        upstreamUrl: targetUrl,
        status,
        durationMs: Date.now() - startedAt,
        responseHeaders: upstreamRes.headers,
        responseContentType: contentType,
        responseBody: Buffer.concat(chunks).toString('utf8'),
        sse: contentType.includes('text/event-stream')
      });
      return { ok: true, status, upstream: upstream.name, attempts };
    } catch (err) {
      lastError = err;
      attempts.push({ upstream: upstream.name, error: err.message, url: targetUrl });
      logger?.warn?.('upstream ' + upstream.name + ' failed: ' + err.message);
      if (i === upstreamOrder.length - 1) break;
      continue;
    }
  }
  return { ok: false, error: lastError, attempts };
}
