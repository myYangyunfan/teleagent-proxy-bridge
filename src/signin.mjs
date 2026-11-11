import fs from 'node:fs';
import path from 'node:path';
import { resolveToken } from './session.mjs';

/**
 * 每日签到（积分福利社 daily_login）
 *
 * 证据链（全部实测）:
 *   GET {origin}/superCowork/sapi/user/portal/companyStore/v3/checkDayTask?theme=light
 *     -> data.activity_data[] 里 action_type="api"、action_status!="completed" 的项
 *        其 jump_url 形如 /superCowork/sapi/user/portal/companyStore/checkTask?type=daily_login
 *   领奖 = 直接 GET 该 jump_url（app 里的 D() 就是 jump_url.replace("/superCowork/sapi","") 后 pr()）。
 *   已领取时回 {code:200,data:[]}；未领取时回 {code:200,data:[...]}。
 *   只需 X-Token（app 的登录 token），无需 X-SA-* 签名。
 */

export const DEFAULT_SIGNIN = {
  enabled: true,
  origin: 'https://agent.teleai.com.cn',
  apiPrefix: '/superCowork/sapi',
  window: { start: '08:20', end: '11:40' },
  stateFile: '.signin-state.json',
  logFile: 'signin.log',
  userAgent: 'SuperAgent/1.0',
  taskTypes: ['daily_login'],
  preClaimDelayMs: [2500, 9000],
  // 窗口错过（机器关机）后当天仍可补签，直到这个时间
  catchupUntil: '23:30',
  timeoutMs: 20000
};

const pad = (n) => String(n).padStart(2, '0');

export function localDateKey(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function parseHm(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return h * 60 + mi;
}

/** Window as minutes since local midnight. Accepts "08:20-11:40" strings. */
export function parseWindow(spec, fallback) {
  if (!spec) return fallback;
  const [a, b] = String(spec).split('-');
  const start = parseHm(a, fallback.start);
  const end = parseHm(b, fallback.end);
  return end > start ? { start, end } : fallback;
}

/** Normalizes config.signin (window may be {start:'08:20',end:'11:40'} strings) into minutes. */
export function resolveSigninConfig(raw = {}, windowSpec = null) {
  const cfg = { ...DEFAULT_SIGNIN, ...raw };
  const w = raw.window || DEFAULT_SIGNIN.window;
  let startMin = DEFAULT_SIGNIN.window.start;
  let endMin = DEFAULT_SIGNIN.window.end;
  if (w && typeof w === 'object') {
    startMin = typeof w.start === 'string' ? parseHm(w.start, startMin) : Number(w.start) || startMin;
    endMin = typeof w.end === 'string' ? parseHm(w.end, endMin) : Number(w.end) || endMin;
  }
  cfg.window = parseWindow(windowSpec, { start: startMin, end: endMin });
  return cfg;
}

// Deterministic-per-day pseudo random so a restart does not re-roll the planned time.
function seededFraction(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export function planForDay(dateKey, window) {
  const span = Math.max(1, window.end - window.start);
  const minutes = window.start + Math.floor(seededFraction('tpb-signin:' + dateKey) * span);
  const d = new Date(dateKey + 'T00:00:00');
  d.setMinutes(minutes, 0, 0);
  return d;
}

export function readState(root = process.cwd(), cfg = DEFAULT_SIGNIN) {
  const file = path.resolve(root, cfg.stateFile || DEFAULT_SIGNIN.stateFile);
  if (!fs.existsSync(file)) return { version: 1, days: {}, file };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, days: raw.days || {}, file };
  } catch {
    return { version: 1, days: {}, file };
  }
}

export function writeState(state) {
  const out = { version: 1, updatedAt: new Date().toISOString(), days: state.days };
  fs.writeFileSync(state.file, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

export function dayRecord(state, dateKey) {
  const rec = state.days[dateKey];
  if (rec) return rec;
  const fresh = { date: dateKey, plannedAt: null, done: false, results: [] };
  state.days[dateKey] = fresh;
  return fresh;
}

export function pruneOldDays(state, keepDays = 31) {
  const keys = Object.keys(state.days).sort();
  while (keys.length > keepDays) {
    delete state.days[keys.shift()];
  }
}

/* ---------------- HTTP ---------------- */

export async function portalGet({ origin, prefix, token, apiPath, cfg = DEFAULT_SIGNIN }) {
  const base = String(origin || cfg.origin).replace(/\/+$/, '');
  const pre = String(prefix ?? cfg.apiPrefix ?? '').replace(/\/+$/, '');
  const p = apiPath.startsWith('/') ? apiPath : '/' + apiPath;
  const url = base + pre + p;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Token': token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': cfg.userAgent || DEFAULT_SIGNIN.userAgent
      },
      signal: controller.signal
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { url, status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export async function fetchDayTask({ token, origin, prefix, cfg = DEFAULT_SIGNIN }) {
  const r = await portalGet({ origin, prefix, token, apiPath: '/user/portal/companyStore/v3/checkDayTask?theme=light', cfg });
  if (r.status === 200 && r.body && r.body.code === 200) return r;
  const legacy = await portalGet({ origin, prefix, token, apiPath: '/user/portal/companyStore/v2/checkDayTask', cfg });
  return legacy;
}

export function listTasks(dayTaskBody) {
  const items = (dayTaskBody && dayTaskBody.data && dayTaskBody.data.activity_data) || [];
  return items.map((it) => ({
    title: stripTags(it.activity_title),
    actionText: it.action_text,
    status: it.action_status,
    type: it.action_type,
    jumpUrl: it.jump_url,
    main: !!it.is_main_activity
  }));
}

export function claimable(tasks, taskTypes = DEFAULT_SIGNIN.taskTypes) {
  const wanted = taskTypes.map((t) => String(t).toLowerCase());
  return tasks.filter((t) => {
    if (t.type !== 'api') return false;
    if (t.status === 'completed') return false;
    const u = String(t.jumpUrl || '');
    if (!u) return false;
    return wanted.some((w) => u.toLowerCase().includes('type=' + w));
  });
}

export function normalizeJumpUrl(jumpUrl, prefix) {
  const pre = String(prefix ?? DEFAULT_SIGNIN.apiPrefix ?? '');
  let p = String(jumpUrl || '');
  if (pre && p.startsWith(pre)) p = p.slice(pre.length) || '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

const randBetween = ([lo, hi]) => lo + Math.floor(Math.random() * Math.max(1, hi - lo));

export function tokenInfo(token) {
  try {
    const seg = String(token).split('.')[1];
    const payload = JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { exp: payload.exp ? new Date(payload.exp * 1000) : null, tenant: payload.tenant || null, userId: payload.userId || payload.sub || null };
  } catch {
    return { exp: null, tenant: null, userId: null };
  }
}

/**
 * Run one check-in pass. Never throws for expected conditions; returns a report object.
 * opts: { root, cfg, dryRun, token }
 */
export async function runSignin({ root = process.cwd(), cfg = DEFAULT_SIGNIN, dryRun = false, token: injectedToken = null } = {}) {
  const log = [];
  const add = (level, msg) => log.push({ at: new Date().toISOString(), level, msg });

  let token = injectedToken;
  try {
    if (!token) token = resolveToken(root).token;
  } catch (err) {
    add('error', '读取 app token 失败: ' + err.message);
    return { ok: false, claimed: [], log };
  }
  const info = tokenInfo(token);
  if (info.exp && info.exp.getTime() < Date.now() + 60_000) {
    add('error', 'token 已过期 (' + info.exp.toISOString() + '); 先打开 TeleAgent 重新登录');
    return { ok: false, claimed: [], log, tokenExpired: true };
  }

  const dayTask = await fetchDayTask({ token, origin: cfg.origin, prefix: cfg.apiPrefix, cfg });
  add('info', 'checkDayTask -> HTTP ' + dayTask.status + ' code ' + (dayTask.body && dayTask.body.code));
  if (dayTask.status !== 200 || !dayTask.body || dayTask.body.code !== 200) {
    add('error', 'checkDayTask 失败: ' + String(dayTask.text || '').slice(0, 200));
    return { ok: false, claimed: [], log };
  }

  const tasks = listTasks(dayTask.body);
  for (const t of tasks) add('info', 'task: ' + (t.title || '(untitled)') + ' | status=' + t.status + ' | type=' + t.type + ' | ' + t.jumpUrl);
  const todo = claimable(tasks, cfg.taskTypes);
  if (!todo.length) {
    add('info', '今天没有可领取的签到任务（可能已领过）');
    return { ok: true, claimed: [], tasks, log, alreadyDone: true };
  }

  const claimed = [];
  for (const t of todo) {
    const apiPath = normalizeJumpUrl(t.jumpUrl, cfg.apiPrefix);
    if (dryRun) {
      add('info', '[dry-run] 将 GET ' + apiPath);
      claimed.push({ title: t.title, apiPath, dryRun: true });
      continue;
    }
    const delayRange = cfg.preClaimDelayMs || DEFAULT_SIGNIN.preClaimDelayMs;
    const pause = Array.isArray(delayRange) ? randBetween(delayRange) : Number(delayRange) || 0;
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    const r = await portalGet({ token, origin: cfg.origin, prefix: cfg.apiPrefix, apiPath, cfg });
    const okBody = r.status === 200 && r.body && r.body.code === 200;
    const reward = okBody ? JSON.stringify(r.body.data || null).slice(0, 300) : '';
    add(okBody ? 'info' : 'error', 'claim ' + apiPath + ' -> HTTP ' + r.status + (okBody ? ' code 200 data=' + reward : ' ' + String(r.text || '').slice(0, 200)));
    claimed.push({ title: t.title, apiPath, status: r.status, code: r.body && r.body.code, data: r.body && r.body.data });
    if (r.status === 401) break;
  }

  // Refresh the points balance once, mirroring what the app does after a successful claim.
  if (!dryRun && claimed.some((c) => c.status === 200)) {
    const detail = await portalGet({ token, origin: cfg.origin, prefix: cfg.apiPrefix, apiPath: '/user/portal/points/detail', cfg });
    const balance = detail.body && detail.body.data && detail.body.data.pointsBalance;
    add('info', 'points/detail -> HTTP ' + detail.status + ' balance=' + balance);
  }
  return { ok: true, claimed, tasks, log };
}

/* ---------------- daily daemon ---------------- */

/**
 * Chooses the next run moment.
 *  - today's plan still ahead  -> that moment
 *  - window already passed but the day is still claimable (<= catchupUntil) -> catch-up in a few minutes
 *  - already done today, or too late -> tomorrow's random plan
 */
export function nextRunPlan({ root = process.cwd(), cfg = DEFAULT_SIGNIN, now = new Date(), force = false } = {}) {
  const state = readState(root, cfg);
  const todayKey = localDateKey(now);
  let rec = state.days[todayKey] || dayRecord(state, todayKey);
  if (!rec.plannedAt) {
    rec.plannedAt = planForDay(todayKey, cfg.window || DEFAULT_SIGNIN.window).toISOString();
    writeState(state);
  }

  const catchupMinute = parseHm(cfg.catchupUntil, 23 * 60 + 30);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const plannedAt = new Date(rec.plannedAt);
  let target = plannedAt;
  let mode = 'scheduled';

  if (!force) {
    if (rec.done || rec.skipped) {
      target = null;
    } else if (now.getTime() > plannedAt.getTime() && nowMinutes <= catchupMinute) {
      // window missed while the machine was off/awake later: still claimable today
      target = new Date(now.getTime() + (60 + Math.floor(Math.random() * 14 * 60)) * 1000);
      mode = 'catchup';
    } else if (nowMinutes > catchupMinute) {
      target = null;
    }
  }

  if (!target) {
    if (!rec.done) {
      rec.skipped = true;
      rec.skippedReason = 'window passed before the daemon could run';
    }
    const tomorrow = new Date(now.getTime() + 86400_000);
    const key = localDateKey(tomorrow);
    const trec = state.days[key] || dayRecord(state, key);
    if (!trec.plannedAt) trec.plannedAt = planForDay(key, cfg.window || DEFAULT_SIGNIN.window).toISOString();
    writeState(state);
    pruneOldDays(state);
    writeState(state);
    return { when: new Date(trec.plannedAt), state, rec: trec, mode: 'tomorrow' };
  }

  pruneOldDays(state);
  writeState(state);
  return { when: target, state, rec, mode };
}

/** Local wall clock without locale text (log files stay readable on a GBK console). */
export function localStamp(d = new Date()) {
  return localDateKey(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** Counts one run attempt for the day (retries are bounded so a broken endpoint cannot loop forever). */
export function recordAttempt({ root = process.cwd(), cfg = DEFAULT_SIGNIN, dateKey }) {
  const state = readState(root, cfg);
  const rec = dayRecord(state, dateKey);
  rec.attempts = (rec.attempts || 0) + 1;
  rec.lastAttemptAt = new Date().toISOString();
  writeState(state);
  return rec.attempts;
}

/** Gives up on this day after too many failed attempts. */
export function markSkipped({ root = process.cwd(), cfg = DEFAULT_SIGNIN, dateKey, reason }) {
  const state = readState(root, cfg);
  const rec = dayRecord(state, dateKey);
  rec.skipped = true;
  rec.skippedReason = reason || 'too many failed attempts';
  writeState(state);
}

export function markDone({ root = process.cwd(), cfg = DEFAULT_SIGNIN, dateKey, report }) {
  const state = readState(root, cfg);
  const rec = dayRecord(state, dateKey);
  rec.done = true;
  rec.ranAt = new Date().toISOString();
  rec.results = (report.claimed || []).map((c) => ({ title: c.title, apiPath: c.apiPath, status: c.status, code: c.code }));
  rec.ok = !!report.ok;
  pruneOldDays(state);
  writeState(state);
}

