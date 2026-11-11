import http from 'node:http';
import { URL } from 'node:url';
import { readBody, pickUpstream, forward, sendJson, applyModelAlias } from './proxy.mjs';
import { createCapture } from './capture.mjs';
import { createAdminHandler } from './admin.mjs';
import { resolveKey, recordKeyUsage } from './pool.mjs';

export function createLogger(level = 'info') {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const threshold = order[level] ?? 3;
  const emit = (name, stream, args) => {
    if ((order[name] ?? 3) > threshold) return;
    stream(JSON.stringify({ t: new Date().toISOString(), level: name, msg: args.map(String).join(' ') }));
  };
  return {
    error: (...a) => emit('error', console.error, a),
    warn: (...a) => emit('warn', console.error, a),
    info: (...a) => emit('info', console.log, a),
    debug: (...a) => emit('debug', console.log, a)
  };
}

function bearerOf(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const alt = req.headers['x-api-key'];
  return typeof alt === 'string' ? alt.trim() : null;
}

function upstreamOrderFor(cfg, preferredName) {
  const byName = new Map(cfg.upstreams.map((u) => [u.name, u]));
  const order = [];
  if (preferredName && byName.has(preferredName)) order.push(byName.get(preferredName));
  if (cfg.failover?.enabled !== false) {
    for (const u of cfg.upstreams) if (!order.includes(u)) order.push(u);
  }
  return order.map((u) => ({ ...u, prefix: u.prefix }));
}

export function createBridge({ config, logger = createLogger(config.logLevel) }) {
  const root = process.cwd();
  const capture = createCapture(config.capture, logger);
  const startedAt = Date.now();
  const stats = {
    requests: 0,
    byPath: {},
    byStatus: {},
    passthrough: 0,
    frontDoor: 0,
    failovers: 0,
    errors: 0,
    lastRequestAt: null
  };

  const admin = createAdminHandler({
    root,
    config,
    getStats: () => stats,
    getPort: () => (server.address() ? server.address().port : config.listen.port)
  });

  function bumpPath(pathname) {
    stats.byPath[pathname] = (stats.byPath[pathname] || 0) + 1;
  }

  const server = http.createServer(async (req, res) => {
    const startedRequest = Date.now();
    stats.requests += 1;
    stats.lastRequestAt = new Date().toISOString();
    let pathname = '/';
    let search = '';
    try {
      const parsed = new URL(req.url || '/', 'http://bridge.local');
      pathname = parsed.pathname;
      search = parsed.search;
    } catch {
      sendJson(res, 400, { error: { message: 'invalid url', type: 'invalid_request_error' } });
      return;
    }
    bumpPath(pathname);

    // ---- management surface -------------------------------------------------
    if (config.admin?.enabled !== false) {
      if (pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          uptimeMs: Date.now() - startedAt,
          upstreams: config.upstreams.map((u) => ({ name: u.name, baseUrl: u.baseUrl })),
          capture: capture.enabled ? capture.file : null
        });
        return;
      }
      if (pathname === '/stats' && req.method === 'GET') {
        sendJson(res, 200, { ...stats, uptimeMs: Date.now() - startedAt });
        return;
      }
      if (pathname === '/admin/reload' && req.method === 'POST') {
        sendJson(res, 501, { error: { message: 'reload is handled by the CLI process; restart the bridge to apply config' } });
        return;
      }
    }

    // ---- control panel (loopback only) -------------------------------------
    if (await admin(req, res, pathname, search)) return;

    // ---- OpenAI-compatible front door --------------------------------------
    const openai = config.openai;
    const isFrontDoor = openai?.enabled && (pathname === '/v1' || pathname.startsWith('/v1/'));
    if (isFrontDoor) {
      stats.frontDoor += 1;
      if (openai.requireKey) {
        const key = bearerOf(req);
        let verdict = key ? resolveKey(root, key, openai.keys || []) : { ok: false, reason: 'empty' };
        if (!verdict.ok) {
          sendJson(res, 401, {
            error: {
              message: 'invalid api key' + (verdict.reason === 'quota' ? ' (quota exceeded)' : ''),
              type: 'invalid_request_error',
              code: 'invalid_api_key'
            }
          });
          return;
        }
        if (verdict.source === 'pool') recordKeyUsage(root, verdict.id, 1);
      }
      if (pathname === '/v1/models' && req.method === 'GET') {
        const ids = Object.keys(config.modelAliases || {});
        const models = (openai.models && openai.models.length ? openai.models : ids).map((id) => ({
          id: String(id),
          object: 'model',
          created: Math.floor(startedAt / 1000),
          owned_by: 'tele-proxy-bridge'
        }));
        sendJson(res, 200, { object: 'list', data: models });
        return;
      }
      const preferred = config.upstreams.find((u) => u.name === openai.upstream) || config.upstreams[0];
      const upstreamPath = pathname.replace(/^\/v1/, '') || '/';
      const forwardedPath = (preferred.matchPrefix || '/api/v1') + (upstreamPath.startsWith('/') ? upstreamPath : '/' + upstreamPath);
      return handleProxy({ req, res, pathname: forwardedPath, search, preferredName: preferred.name, injectHeaders: openai.headers, isFrontDoor: true });
    }

    // ---- transparent passthrough for the TeleAgent app ---------------------
    const { upstream, prefix } = pickUpstream(config.upstreams, pathname);
    if (!upstream) {
      sendJson(res, 404, {
        error: {
          message: 'no upstream matches ' + pathname,
          hint: 'point the TeleAgent app at this bridge (tele-proxy-bridge hook install) or call /v1/chat/completions'
        }
      });
      return;
    }
    return handleProxy({ req, res, pathname, search, preferredName: upstream.name, matchPrefix: prefix, injectHeaders: null, isFrontDoor: false });

    async function handleProxy({ req, res, pathname: targetPath, search, preferredName, matchPrefix, injectHeaders, isFrontDoor }) {
      stats.passthrough += isFrontDoor ? 0 : 1;
      const ctx = capture.begin({ method: req.method, path: targetPath, mode: isFrontDoor ? 'front-door' : 'passthrough' });
      let body;
      try {
        body = await readBody(req, config.limits?.maxRequestBytes ?? 32 * 1024 * 1024);
      } catch (err) {
        stats.errors += 1;
        sendJson(res, err.statusCode || 400, { error: { message: err.message, type: 'invalid_request_error' } });
        capture.finish({ ...ctx, status: err.statusCode || 400, error: err.message, durationMs: Date.now() - startedRequest, requestHeaders: req.headers, requestBody: '' });
        return;
      }

      const aliased = applyModelAlias(body, config.modelAliases);
      if (aliased.changed) {
        logger.info('model alias ' + aliased.original + ' -> ' + aliased.model + ' (' + targetPath + ')');
        body = aliased.buffer;
      }

      const order = upstreamOrderFor(config, preferredName).map((u) => ({ ...u, prefix: matchPrefix ?? u.match?.[0] ?? '/api/v1' }));
      if (injectHeaders) {
        order.forEach((u) => {
          u.headers = { ...(u.headers || {}), ...injectHeaders };
        });
      }

      const result = await forward({
        req,
        res,
        cfg: config,
        upstreamOrder: order,
        pathname: targetPath,
        search,
        body,
        logger,
        captureCtx: {
          done: (info) => {
            stats.byStatus[info.status] = (stats.byStatus[info.status] || 0) + 1;
            capture.finish({
              ...ctx,
              status: info.status,
              durationMs: Date.now() - startedRequest,
              requestHeaders: req.headers,
              requestBody: body ? body.toString('utf8') : '',
              model: aliased.model,
              upstream: info.upstream,
              upstreamUrl: info.upstreamUrl,
              responseHeaders: info.responseHeaders,
              responseContentType: info.responseContentType,
              responseBody: info.responseBody,
              sse: info.sse
            });
          }
        }
      });

      if (!result.ok) {
        stats.errors += 1;
        if (result.attempts.length > 1) stats.failovers += 1;
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: {
              message: 'all upstreams failed: ' + (result.error?.message || 'unknown'),
              type: 'upstream_error',
              attempts: result.attempts
            }
          });
        } else {
          res.end();
        }
        capture.finish({
          ...ctx,
          status: 502,
          durationMs: Date.now() - startedRequest,
          requestHeaders: req.headers,
          requestBody: body ? body.toString('utf8') : '',
          error: result.error?.message,
          attempts: result.attempts
        });
        return;
      }
      if (result.attempts.length > 0) stats.failovers += 1;
    }
  });

  return {
    server,
    capture,
    stats,
    logger,
    listen(host = config.listen.host, port = config.listen.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          logger.info('bridge listening on http://' + addr.address + ':' + addr.port);
          resolve(addr);
        });
      });
    },
    async close() {
      // Undici/Node keep-alive sockets would otherwise keep server.close() pending forever.
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
  };
}
