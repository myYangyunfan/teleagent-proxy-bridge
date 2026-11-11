import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveToken } from './session.mjs';
import { hookState, hookInstall, hookUninstall, hookUrlFor } from './hook.mjs';
import { readState, runSignin, resolveSigninConfig, localDateKey, markDone, nextRunPlan } from './signin.mjs';
import {
  appRunning, lastRelayUrl, autostartInstalled, ensureAutostart, removeAutostart, restartApp,
  findAppExe, signinDaemonStatus, startSigninDaemon, stopSigninDaemon, tailFile, runtimePaths
} from './lifecycle.mjs';
import { sendJson } from './proxy.mjs';
import {
  listAccounts, listKeys, getModels, poolSummary, addAccount, removeAccount, toggleAccount,
  probeAccount, importFromTeleAgent, createKey, revokeKey, toggleKey, setAlias, toggleModel
} from './pool.mjs';

const UI_DIR = new URL('./webui/', import.meta.url);
const UI_ENTRY = new URL('index.html', UI_DIR);

/* ------------------------------ helpers ------------------------------ */

function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

let tokenCache = { at: 0, value: null };
let pointsCache = { at: 0, value: null };

async function fetchPoints(config, token) {
  if (Date.now() - pointsCache.at < 300000 && pointsCache.value !== null) return pointsCache.value;
  const cfg = resolveSigninConfig(config.signin);
  const url = String(cfg.origin).replace(/\/+$/, '') + String(cfg.apiPrefix || '') + '/user/portal/points/detail';
  try {
    const res = await fetch(url, {
      headers: { 'x-token': token, 'user-agent': cfg.userAgent || 'SuperAgent/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json();
    const data = body && (body.data || body);
    const value = data && (data.pointsBalance ?? data.pointBalance ?? data.balance ?? null);
    pointsCache = { at: Date.now(), value };
    return value;
  } catch {
    pointsCache = { at: Date.now(), value: null };
    return null;
  }
}
function cachedToken() {
  if (Date.now() - tokenCache.at < 45000) return tokenCache.value;
  let value;
  try {
    const t = resolveToken(root);
    value = {
      ok: true, token: t.token, source: t.source,
      payload: { tenant: t.tenant, userId: t.userId, exp: t.exp },
      accountName: t.name || null
    };
  } catch (err) {
    value = { ok: false, error: err.message };
  }
  tokenCache = { at: Date.now(), value };
  return value;
}

function readCaptures(file, limit = 30) {
  const out = { file, bytes: 0, count: 0, items: [] };
  try {
    const st = fs.statSync(file);
    out.bytes = st.size;
  } catch {
    return out;
  }
  let text = '';
  try {
    const st = fs.statSync(file);
    const take = Math.min(st.size, 2 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, st.size - take);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    out.count = (text.match(/\n/g) || []).length + (st.size === text.length ? 0 : 0);
  } catch {
    return out;
  }
  const rows = text.split('\n').filter(Boolean).slice(-limit);
  for (const row of rows.reverse()) {
    try {
      const r = JSON.parse(row);
      out.items.push({
        id: r.id, at: r.startedAt || r.at || null, mode: r.mode || null,
        method: r.method || null, path: r.path || null, status: r.status ?? null,
        model: r.model || null, durationMs: r.durationMs ?? null,
        requestBytes: r.request?.bodyBytes ?? (r.requestBody ? r.requestBody.length : null)
      });
    } catch {
      /* skip damaged / partial line */
    }
  }
  return out;
}

async function buildState({ root, config, stats, actualPort }) {
  const rp = runtimePaths(root);
  const hook = hookState();
  const signinCfg = resolveSigninConfig(config.signin);
  const state = readState(root, signinCfg);
  const todayKey = localDateKey();
  const rec = state.days[todayKey] || null;
  const plan = nextRunPlan({ root, cfg: signinCfg });
  const token = cachedToken();
  const points = token.ok ? await fetchPoints(config, token.token) : null;
  const daemon = signinDaemonStatus(root);
  const captureFile = path.resolve(root, config.capture?.dir || 'captures', config.capture?.file || 'requests.jsonl');
  const captures = readCaptures(captureFile, 12);
  let relay = null;
  try { relay = lastRelayUrl(); } catch { relay = null; }
  return {
    now: new Date().toISOString(),
    bridge: {
      ok: true, pid: process.pid, port: actualPort || config.listen.port,
      host: config.listen.host, uptimeMs: Math.round(process.uptime() * 1000),
      stats, captures
    },
    hook: {
      installed: !!(hook.current && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/.test(String(hook.current))),
      current: hook.current, expected: hookUrlFor(config), file: hook.file, exists: hook.exists
    },
    app: { running: appRunning(), relay, exe: findAppExe() },
    autostart: { installed: autostartInstalled() },
    signin: {
      daemon, window: signinCfg.window, catchupUntil: signinCfg.catchupUntil,
      today: rec ? { date: rec.date, plannedAt: rec.plannedAt, done: !!rec.done, skipped: !!rec.skipped, attempts: rec.attempts || 0, skippedReason: rec.skippedReason || null, last: (rec.results || []).slice(-1)[0] || null } : null,
      plan: plan ? { mode: plan.mode, at: plan.at ? plan.at.toISOString() : null } : null,
      stateFile: state.file
    },
    openai: {
      enabled: config.openai?.enabled !== false,
      requireKey: config.openai?.requireKey !== false,
      key: (config.openai?.keys || [])[0] || null,
      keys: config.openai?.keys || [],
      baseUrl: 'http://127.0.0.1:' + (actualPort || config.listen.port) + (config.openai?.prefix || '/v1'),
      models: config.openai?.models || [],
      aliases: config.modelAliases || {}
    },
    pool: poolSummary(root),
    accounts: listAccounts(root),
    keys: listKeys(root),
    models: getModels(root, [...(config.openai?.models || []), ...Object.keys(config.modelAliases || {})]),
    points,
    token: token.ok
      ? { ok: true, exp: token.payload?.exp ? new Date(token.payload.exp * 1000).toISOString() : null, tenant: token.payload?.tenant || null, userId: token.payload?.userId || null, expiresInDays: token.payload?.exp ? Math.round((token.payload.exp * 1000 - Date.now()) / 86400000) : null }
      : { ok: false, error: token.error }
  };
}

/* ------------------------------ actions ------------------------------ */

async function runAction({ action, root, config, payload = {} }) {
  switch (action) {
    case 'hook-install': {
      const url = hookUrlFor(config);
      const r = hookInstall(url, { quiet: true });
      return { message: r.changed ? '已接管：hook -> ' + url + '（重启 TeleAgent 生效）' : 'hook 已经指向 ' + url, detail: r };
    }
    case 'hook-uninstall': {
      const r = hookUninstall({ quiet: true });
      return { message: '已还原：TeleAgent 走官方中转（重启 TeleAgent 生效）', detail: r };
    }
    case 'app-restart': {
      const exe = findAppExe();
      if (!exe) throw new Error('找不到 TeleAgent.exe');
      const r = restartApp(exe);
      return { message: 'TeleAgent 已重启', detail: r };
    }
    case 'signin-now': {
      const cfg = resolveSigninConfig(config.signin);
      const report = await runSignin({ root, cfg });
      const claimed = Array.isArray(report.claimed) ? report.claimed.length : Number(report.claimed || 0);
      try {
        const rp = runtimePaths(root);
        const stamp = new Date().toISOString();
        const lines = ['=== ' + stamp + ' manual check-in from the panel ==='].concat((report.log || []).map((l) => '  ' + l.level + '  ' + l.msg));
        fs.appendFileSync(rp.signinLogFile, lines.join('\n') + '\n');
      } catch { /* log file is best effort */ }
      if (report.ok) {
        markDone({ root, cfg, dateKey: localDateKey(), report });
      }
      return {
        message: report.ok ? (claimed > 0 ? '签到成功，领取 ' + claimed + ' 项' : '签到完成（今天没有可领取的奖励）') : '签到失败：' + (report.error || 'unknown'),
        detail: report
      };
    }
    case 'signin-start': {
      const r = startSigninDaemon({ root });
      return { message: r.already ? '签到守护已在运行 (pid ' + r.pid + ')' : '签到守护已启动 (pid ' + r.pid + ')', detail: r };
    }
    case 'signin-stop': {
      const r = stopSigninDaemon(root);
      return { message: r.killed ? '签到守护已停止' : '签到守护原本未运行', detail: r };
    }
    case 'autostart-on': {
      const r = ensureAutostart({ root });
      return { message: '已设置开机自启', detail: r };
    }
    case 'autostart-off': {
      removeAutostart(root);
      return { message: '已取消开机自启', detail: null };
    }
    case 'open-captures': {
      const dir = path.resolve(root, config.capture?.dir || 'captures');
      execFile('explorer.exe', [dir], { windowsHide: true }, () => {});
      return { message: '已打开 ' + dir, detail: null };
    }
    case 'account-import': {
      const acc = importFromTeleAgent(root);
      return { message: '已导入 ' + acc.name + '（' + acc.userId + '）', detail: acc };
    }
    case 'account-add': {
      const acc = addAccount(root, { name: payload.name, token: payload.token });
      return { message: '已加入号池：' + acc.name, detail: acc };
    }
    case 'account-remove': {
      const r = removeAccount(root, payload.id);
      return { message: r.removed ? '已移出号池' : '账号不存在', detail: r };
    }
    case 'account-toggle': {
      const r = toggleAccount(root, payload.id, payload.enabled);
      return { message: r.enabled ? '已启用' : '已停用', detail: r };
    }
    case 'account-probe': {
      const cfg = resolveSigninConfig(config.signin);
      const r = await probeAccount(root, payload.id, cfg);
      return {
        message: r.ok ? '探测成功：积分 ' + (r.points ?? '?') + '，任务 ' + r.tasks : '探测失败：' + (r.error || '未知'),
        detail: r
      };
    }
    case 'key-create': {
      const r = createKey(root, { label: payload.label, limit: payload.limit });
      return { message: '已签发 ' + r.label, detail: r };
    }
    case 'key-revoke': {
      const r = revokeKey(root, payload.id);
      return { message: r.removed ? '密钥已吊销' : '密钥不存在', detail: r };
    }
    case 'key-toggle': {
      const r = toggleKey(root, payload.id, payload.enabled);
      return { message: r.enabled ? '密钥已启用' : '密钥已停用', detail: r };
    }
    case 'model-alias': {
      setAlias(root, payload.name, payload.target);
      return { message: payload.target ? '已把 ' + payload.name + ' 指向 ' + payload.target : '已清除别名', detail: null };
    }
    case 'model-toggle': {
      const r = toggleModel(root, payload.name, payload.enabled);
      return { message: (r.enabled ? '已启用模型 ' : '已停用模型 ') + r.name, detail: r };
    }
    default:
      throw new Error('unknown action: ' + action);
  }
}

/* ------------------------------ routing ------------------------------ */

export function createAdminHandler({ root, config, getStats, getPort }) {
  let uiCache = null;
  let uiMtime = 0;
  function ui(req, res) {
    // re-read when the file changes (dev convenience, the file is ~35 KB)
    const st = fs.statSync(UI_ENTRY);
    if (!uiCache || st.mtimeMs !== uiMtime) { uiCache = fs.readFileSync(UI_ENTRY, 'utf8'); uiMtime = st.mtimeMs; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(uiCache);
  }
  return async function handleAdmin(req, res, pathname, search) {
    const url = new URL(pathname + (search || ''), 'http://bridge.local');
    if (pathname === '/' || pathname === '/ui' || pathname === '/dashboard') {
      if (pathname !== '/' && isLoopback(req)) { ui(req, res); return true; }
      res.writeHead(302, { location: '/ui' });
      res.end();
      return true;
    }
    if (!pathname.startsWith('/admin/')) return false;
    if (!isLoopback(req)) { sendJson(res, 403, { ok: false, error: 'dashboard is loopback only' }); return true; }

    try {
      if (pathname === '/admin/state' && req.method === 'GET') {
        sendJson(res, 200, await buildState({ root, config, stats: getStats(), actualPort: getPort() }));
        return true;
      }
      if (pathname === '/admin/logs' && req.method === 'GET') {
        const which = url.searchParams.get('which') || 'signin';
        const rp = runtimePaths(root);
        const file = which === 'bridge' ? rp.logFile : rp.signinLogFile;
        const tail = tailFile(file, Number(url.searchParams.get('bytes') || 24000)) || '(空)';
        sendJson(res, 200, { ok: true, which, file, text: tail });
        return true;
      }
      if (pathname === '/admin/action' && req.method === 'POST') {
        if (req.headers['x-tpb-admin'] !== '1') { sendJson(res, 403, { ok: false, error: 'missing x-tpb-admin header' }); return true; }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { /* empty */ }
        const result = await runAction({ action: body.action, root, config, payload: body });
        sendJson(res, 200, { ok: true, ...result });
        return true;
      }
      sendJson(res, 404, { ok: false, error: 'unknown admin route ' + pathname });
      return true;
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
      return true;
    }
  };
}
