import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge, createLogger } from '../src/server.mjs';
import { deepMerge, DEFAULT_CONFIG } from '../src/config.mjs';
import { buildTargetUrl } from '../src/proxy.mjs';
import {
  planForDay, parseWindow, resolveSigninConfig, normalizeJumpUrl, claimable, listTasks,
  localDateKey, DEFAULT_SIGNIN, runSignin
} from '../src/signin.mjs';

const openMocks = [];

test.after(async () => {
  for (const server of openMocks) {
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    await new Promise((resolve) => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      setTimeout(resolve, 200).unref();
    });
  }
});

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    openMocks.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function stopMock(server) {
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

async function startBridge(overrides) {
  const config = deepMerge(structuredClone(DEFAULT_CONFIG), overrides);
  const logger = createLogger('silent');
  const bridge = await createBridge({ config, logger });
  const addr = await bridge.listen('127.0.0.1', 0);
  return { bridge, port: addr.port, config };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tpb-test-'));
}

test('canonical upstream path is forwarded without duplication', () => {
  const up = { baseUrl: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1', match: ['/api/v1', '/superCowork'] };
  assert.equal(
    buildTargetUrl(up, '/superCowork/sapi/api/v1/chat/completions', '', '/superCowork'),
    'https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions'
  );
  assert.equal(
    buildTargetUrl(up, '/api/v1/chat/completions', '?a=1', '/api/v1'),
    'https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions?a=1'
  );
});

test('passthrough forwards method, path, headers and body', async () => {
  let seen = null;
  const { server, port } = await startMock((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const { bridge, port: bport } = await startBridge({
    upstreams: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + port + '/api/v1', match: ['/api/v1'] }],
    capture: { enabled: false }
  });
  const res = await fetch('http://127.0.0.1:' + bport + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': 'secret-token', 'x-sa-signature': 'sig' },
    body: JSON.stringify({ model: 'chat-flash', messages: [{ role: 'user', content: 'hi' }] })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/v1/chat/completions');
  assert.equal(seen.headers['x-token'], 'secret-token');
  assert.equal(seen.headers['x-sa-signature'], 'sig');
  assert.match(seen.body, /chat-flash/);
  await bridge.close();
  server.close();
});

test('front door rejects missing key and forwards with a valid key', async () => {
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, injected: req.headers['x-token'] || null }));
  });
  const { bridge, port: bport } = await startBridge({
    upstreams: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + port, match: ['/api/v1'] }],
    openai: { enabled: true, requireKey: true, keys: ['sk-test'], upstream: 'mock', headers: { 'x-token': 'injected-token' } },
    capture: { enabled: false }
  });
  const denied = await fetch('http://127.0.0.1:' + bport + '/v1/chat/completions', { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);

  const ok = await fetch('http://127.0.0.1:' + bport + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-flash', messages: [] })
  });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.url, '/chat/completions');
  assert.equal(payload.injected, 'injected-token');
  await bridge.close();
  server.close();
});

test('model alias rewrites the request body', async () => {
  const { server, port } = await startMock((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model }));
    });
  });
  const { bridge, port: bport } = await startBridge({
    upstreams: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + port, match: ['/api/v1'] }],
    modelAliases: { 'gpt-4o-mini': 'chat-flash' },
    capture: { enabled: false }
  });
  const res = await fetch('http://127.0.0.1:' + bport + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] })
  });
  assert.equal((await res.json()).model, 'chat-flash');
  await bridge.close();
  server.close();
});

test('SSE responses stream through and are summarised in the capture file', async () => {
  const dir = tmpDir();
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"total_tokens":7}}\n\n'), 20);
    setTimeout(() => res.end('data: [DONE]\n\n'), 40);
  });
  const { bridge, port: bport } = await startBridge({
    upstreams: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + port, match: ['/api/v1'] }],
    capture: { enabled: true, dir }
  });
  const res = await fetch('http://127.0.0.1:' + bport + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [] })
  });
  const text = await res.text();
  assert.match(text, /"你"/);
  assert.match(text, /\[DONE\]/);
  await new Promise((r) => setTimeout(r, 120));
  const file = path.join(dir, 'requests.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const record = JSON.parse(lines[lines.length - 1]);
  assert.equal(record.status, 200);
  assert.equal(record.response.sse.text, '你好');
  assert.equal(record.response.sse.usage.total_tokens, 7);
  await bridge.close();
  server.close();
});

test('failover moves to the next upstream on 5xx', async () => {
  const failing = await startMock((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"down"}');
  });
  const healthy = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ served_by: 'second' }));
  });
  const { bridge, port: bport } = await startBridge({
    upstreams: [
      { name: 'first', baseUrl: 'http://127.0.0.1:' + failing.port, match: ['/api/v1'] },
      { name: 'second', baseUrl: 'http://127.0.0.1:' + healthy.port, match: ['/api/v1'] }
    ],
    failover: { enabled: true, onStatusCode: [503] },
    capture: { enabled: false }
  });
  const res = await fetch('http://127.0.0.1:' + bport + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"chat-flash"}'
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).served_by, 'second');
  assert.ok(bridge.stats.failovers >= 1);
  await bridge.close();
  failing.server.close();
  healthy.server.close();
});

test('capture redacts credential headers', async () => {
  const dir = tmpDir();
  const { server, port } = await startMock((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"echo":true}');
  });
  const { bridge, port: bport } = await startBridge({
    upstreams: [{ name: 'mock', baseUrl: 'http://127.0.0.1:' + port, match: ['/api/v1'] }],
    capture: { enabled: true, dir }
  });
  await fetch('http://127.0.0.1:' + bport + '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', 'x-token': 'tenant:jwt' },
    body: '{"model":"chat-flash"}'
  });
  const file = path.join(dir, 'requests.jsonl');
  const record = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
  assert.equal(record.request.headers.authorization, '[redacted]');
  assert.equal(record.request.headers['x-token'], '[redacted]');
  assert.equal(record.status, 200);
  await bridge.close();
  server.close();
});

/* ---------- 每日签到 ---------- */

test('signin plan is deterministic per day and inside the window', () => {
  const window = { start: 8 * 60 + 20, end: 11 * 60 + 40 };
  const a = planForDay('2026-11-12', window);
  const b = planForDay('2026-11-12', window);
  assert.equal(a.getTime(), b.getTime(), 'same day must not re-roll between restarts');
  const minutes = a.getHours() * 60 + a.getMinutes();
  assert.ok(minutes >= window.start && minutes < window.end, 'planned minute ' + minutes + ' outside window');
  const other = planForDay('2026-11-13', window);
  assert.notEqual(a.getTime(), other.getTime(), 'different days should differ');
});

test('signin window spec parses "HH:MM-HH:MM" and config strings', () => {
  assert.deepEqual(parseWindow('09:05-10:15', { start: 0, end: 1 }), { start: 9 * 60 + 5, end: 10 * 60 + 15 });
  assert.deepEqual(parseWindow('10:00-09:00', { start: 7, end: 8 }), { start: 7, end: 8 }, 'inverted window falls back');
  const cfg = resolveSigninConfig({ window: { start: '08:20', end: '11:40' } });
  assert.equal(cfg.window.start, 8 * 60 + 20);
  assert.equal(cfg.window.end, 11 * 60 + 40);
  assert.equal(cfg.origin, DEFAULT_SIGNIN.origin);
});

test('signin picks only unclaimed api tasks of the wanted type', () => {
  const tasks = listTasks({
    data: {
      activity_data: [
        { activity_title: '<span>双11</span>', action_status: 'fixed', action_type: 'web', jump_url: 'https://agent.teleai.com.cn/meter/x' },
        { activity_title: '每日可领<b>100</b>积分', action_status: 'completed', action_type: 'api', jump_url: '/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login' },
        { activity_title: '签到', action_status: 'unclaimed', action_type: 'api', jump_url: '/superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login' },
        { activity_title: '别的', action_status: 'unclaimed', action_type: 'api', jump_url: '/superCowork/sapi/user/portal/companyStore/checkTask?type=share' }
      ]
    }
  });
  assert.equal(tasks[1].title, '每日可领100积分', 'html tags are stripped');
  const todo = claimable(tasks, ['daily_login']);
  assert.equal(todo.length, 1, 'completed/web/other-type tasks must be filtered out');
  assert.equal(normalizeJumpUrl(todo[0].jumpUrl, '/superCowork/sapi'), '/user/portal/companyStore/checkTask?type=daily_login');
  assert.equal(normalizeJumpUrl('/user/portal/x', '/superCowork/sapi'), '/user/portal/x', 'already-stripped url is untouched');
  assert.equal(claimable(tasks, ['daily_login']).length, 1);
});

test('signin claims an unclaimed daily_login task against a mock portal', async () => {
  const seen = [];
  const { server, port } = await startMock((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/user/portal/companyStore/v3/checkDayTask')) {
      res.end(JSON.stringify({ code: 200, msg: 'success', data: { activity_data: [
        { activity_title: '每日可领<b>100</b>积分', action_status: 'unclaimed', action_type: 'api', jump_url: '/user/portal/companyStore/checkTask?type=daily_login' }
      ] } }));
      return;
    }
    if (req.url.startsWith('/user/portal/companyStore/checkTask') && req.url.includes('type=daily_login')) {
      res.end(JSON.stringify({ code: 200, msg: 'success', data: [{ points: 100 }] }));
      return;
    }
    if (req.url.startsWith('/user/portal/points/detail')) {
      res.end(JSON.stringify({ code: 200, data: { pointsBalance: 6200 } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const report = await runSignin({
    cfg: resolveSigninConfig({ origin: 'http://127.0.0.1:' + port, apiPrefix: '', preClaimDelayMs: [0, 1], timeoutMs: 5000 }),
    token: 'dummy.jwt.token'
  });
  assert.equal(report.ok, true);
  assert.equal(report.claimed.length, 1, 'exactly one claim attempted');
  assert.equal(report.claimed[0].status, 200);
  assert.deepEqual(report.claimed[0].data, [{ points: 100 }]);
  assert.ok(seen.some((u) => u.includes('type=daily_login')), 'claim path was requested');
  assert.ok(seen.some((u) => u.includes('/user/portal/points/detail')), 'balance is refreshed after a claim');
  server.close();
});

test('signin reports already-done without claiming', async () => {
  const seen = [];
  const { server, port } = await startMock((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 200, data: { activity_data: [
      { activity_title: '每日可领100积分', action_status: 'completed', action_type: 'api', jump_url: '/user/portal/companyStore/checkTask?type=daily_login' }
    ] } }));
  });
  const report = await runSignin({
    cfg: resolveSigninConfig({ origin: 'http://127.0.0.1:' + port, apiPrefix: '', timeoutMs: 5000 }),
    token: 'dummy.jwt.token'
  });
  assert.equal(report.ok, true);
  assert.equal(report.alreadyDone, true);
  assert.equal(report.claimed.length, 0);
  assert.equal(seen.length, 1, 'only the status read, no claim request');
  server.close();
});

test('signin date keys are local, zero padded', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
  assert.equal(localDateKey(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
});

test('dashboard html is served from the bridge and stays loopback guarded', async () => {
  const { bridge, port } = await startBridge({ upstreams: [], capture: { enabled: false } });
  const page = await fetch('http://127.0.0.1:' + port + '/ui');
  assert.equal(page.status, 200);
  assert.match(String(page.headers.get('content-type')), /text\/html/);
  const html = await page.text();
  assert.match(html, /TeleProxyBridge 控制台/);
  assert.match(html, /\/admin\/state/);

  const redirect = await fetch('http://127.0.0.1:' + port + '/', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/ui');

  const noHeader = await fetch('http://127.0.0.1:' + port + '/admin/action', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'autostart-on' })
  });
  assert.equal(noHeader.status, 403);

  const unknown = await fetch('http://127.0.0.1:' + port + '/admin/whatever');
  assert.equal(unknown.status, 404);
  await bridge.close();
});

test('pool: keys are issued, resolved and capped by quota', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpb-pool-'));
  const { createKey, resolveKey, recordKeyUsage, revokeKey } = await import('../src/pool.mjs');
  const made = createKey(tmp, { label: 't', limit: 2 });
  assert.match(made.key, /^sk-tpb-/);
  assert.equal(resolveKey(tmp, made.key).ok, true);
  assert.equal(resolveKey(tmp, 'sk-nope').ok, false);
  recordKeyUsage(tmp, made.id, 2);
  const capped = resolveKey(tmp, made.key);
  assert.equal(capped.ok, false);
  assert.equal(capped.reason, 'quota');
  assert.equal(revokeKey(tmp, made.id).removed, 1);
  assert.equal(resolveKey(tmp, made.key).ok, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pool: accounts decode their token and dedupe by tenant+user', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpb-acc-'));
  const { addAccount, listAccounts, toggleAccount, removeAccount, decodeToken } = await import('../src/pool.mjs');
  const payload = Buffer.from(JSON.stringify({ tenant: 'Em9xR4', userId: 'u1', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  const token = 'h.' + payload + '.s';
  assert.equal(decodeToken(token).tenant, 'Em9xR4');
  const a = addAccount(tmp, { name: 'one', token });
  assert.equal(a.userId, 'u1');
  addAccount(tmp, { name: 'dup', token });
  assert.equal(listAccounts(tmp).length, 1);
  toggleAccount(tmp, a.id, false);
  assert.equal(listAccounts(tmp)[0].enabled, false);
  assert.equal(removeAccount(tmp, a.id).removed, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('pool: model aliases and toggles round-trip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpb-mdl-'));
  const { setAlias, toggleModel, getModels } = await import('../src/pool.mjs');
  setAlias(tmp, 'gpt-4o', 'chat-flash');
  toggleModel(tmp, 'chat-pro', false);
  const list = getModels(tmp, ['chat-flash', 'chat-pro']);
  assert.equal(list.find((m) => m.name === 'gpt-4o').alias, 'chat-flash');
  assert.equal(list.find((m) => m.name === 'chat-pro').enabled, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
