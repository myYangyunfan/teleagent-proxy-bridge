#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig, DEFAULT_CONFIG } from './config.mjs';
import { createBridge, createLogger } from './server.mjs';
import { findTeleAgentPaths, readOwner, readAppToken, readCookies } from './teleagent/credentials.mjs';
import { resolveToken } from './session.mjs';
import {
  resolveSigninConfig, runSignin, nextRunPlan, markDone, markSkipped, recordAttempt, readState,
  localDateKey, tokenInfo, localStamp
} from './signin.mjs';
import {
  runtimePaths, health, waitForHealth, startDetached, stopDetached, readPid, tailFile, requestJson,
  findAppExe, appRunning, restartApp, lastRelayUrl, waitForRelayUrl, logCursor, waitForRelayUrlSince,
  ensureAutostart, removeAutostart, autostartInstalled, createDesktopShortcut, CLI_PATH,
  startSigninDaemon, stopSigninDaemon, signinDaemonStatus
} from './lifecycle.mjs';
import { hookState, hookInstall, hookUninstall, hookUrlFor } from './hook.mjs';

const [, , command = 'serve', ...rest] = process.argv;

function flag(name, fallback = null) {
  const idx = rest.indexOf('--' + name);
  return idx >= 0 && rest[idx + 1] ? rest[idx + 1] : fallback;
}

function has(name) {
  return rest.includes('--' + name);
}

const say = (msg) => {
  if (!has('quiet')) console.log(msg);
};

function bridgeBase(config) {
  const host = config.listen.host === '0.0.0.0' ? '127.0.0.1' : config.listen.host;
  return 'http://' + host + ':' + config.listen.port;
}

async function cmdServe() {
  const { config, file, exists } = loadConfig(flag('config'));
  const logger = createLogger(config.logLevel);
  logger.info('config: ' + file + (exists ? '' : ' (defaults only; run "init" to create one)'));
  const bridge = await createBridge({ config, logger }).listen();
  const url = bridgeBase(config).replace(/:\d+$/, ':' + bridge.port);
  logger.info('front door:  ' + url + '/v1/chat/completions  (OpenAI compatible)');
  logger.info('passthrough: ' + url + '/api/v1/*  <- set llmBaseUrl to ' + url + ' to route TeleAgent through the bridge');
  const shutdown = async () => {
    logger.info('shutting down');
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdInit() {
  const file = path.resolve(process.cwd(), 'bridge.config.json');
  if (fs.existsSync(file) && !has('force')) {
    console.error('bridge.config.json already exists (use --force to overwrite)');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
  console.log('wrote ' + file);
}

/* ---------- hook (internal-debug.yaml llmBaseUrl) -> ./hook.mjs ---------- */

async function cmdHook() {
  const action = rest[0] || 'status';
  let defaultUrl = 'http://127.0.0.1:8787/superCowork/sapi';
  try {
    defaultUrl = hookUrlFor(loadConfig(flag('config')).config);
  } catch {
    /* fall back to the built-in default */
  }
  const url = flag('url', defaultUrl);
  if (action === 'status') {
    const st = hookState();
    const backup = st.file + '.tpb-backup';
    console.log('debug file: ' + st.file + (st.exists ? '' : ' (missing)'));
    console.log('llmBaseUrl: ' + (st.current || '(not set)'));
    console.log('backup:     ' + backup + (fs.existsSync(backup) ? ' (present)' : ' (none)'));
    console.log('app log says: ' + (lastRelayUrl(st.paths) || '(no relay line found)'));
    return;
  }
  if (action === 'install') {
    hookInstall(url);
    console.log('restart TeleAgent for it to take effect.');
    return;
  }
  if (action === 'uninstall') {
    hookUninstall();
    console.log('restart TeleAgent for it to take effect.');
    return;
  }
  console.error('unknown hook action: ' + action + ' (status|install|uninstall)');
  process.exitCode = 1;
}

/* ---------- one-click lifecycle ---------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function cmdUp() {
  const startedAt = Date.now();
  const { config, file } = loadConfig(flag('config'));
  const base = bridgeBase(config);
  const rp = runtimePaths(process.cwd());

  say('tele-proxy-bridge up  (' + file + ')');

  let h = await health(base);
  if (h) {
    say('[1/5] bridge already listening on ' + base);
  } else {
    const { pid } = startDetached({ root: process.cwd(), configFile: has('default-config') ? null : null, logFile: rp.logFile });
    h = await waitForHealth(base, 12000);
    if (!h) {
      console.error('[1/5] bridge failed to start; last log lines:\n' + tailFile(rp.logFile, 2000));
      process.exitCode = 1;
      return;
    }
    say('[1/5] bridge started on ' + base + ' (pid ' + pid + ', log ' + rp.logFile + ')');
  }

  const hookUrl = hookUrlFor(config);
  const expectRelay = hookUrl + '/api/v1';
  hookInstall(hookUrl, { quiet: true });
  say('[2/5] TeleAgent hook -> ' + hookUrl);

  if (!has('no-autostart')) {
    try {
      const auto = ensureAutostart({ root: process.cwd() });
      say('[3/5] autostart registered: ' + auto.registry);
    } catch (err) {
      say('[3/5] autostart NOT registered (' + err.message + ') - everything else still works');
    }
  } else {
    say('[3/5] autostart skipped (--no-autostart)');
  }

  const signinCfg = resolveSigninConfig(config.signin || {});
  if (!has('no-signin') && signinCfg.enabled) {
    try {
      const d = startSigninDaemon({ root: process.cwd() });
      const plan = nextRunPlan({ cfg: signinCfg });
      say('[4/5] 每日签到守护 ' + (d.already ? 'already running' : 'started') + ' (pid ' + d.pid + '), 下次 ' + localStamp(plan.when) + ' (' + plan.mode + ')' +
        '  [log ' + d.logFile + ']');
    } catch (err) {
      say('[4/5] 每日签到守护未启动 (' + err.message + ') - 其它功能不受影响');
    }
  } else {
    say('[4/5] 每日签到守护跳过 (' + (has('no-signin') ? '--no-signin' : 'signin.enabled=false') + ')');
  }

  if (has('no-restart')) {
    say('[5/5] TeleAgent restart skipped; restart it yourself if it is running now');
    return;
  }
  const exe = findAppExe();
  if (!exe) {
    console.error('[5/5] TeleAgent.exe not found in known paths; start the app manually');
    return;
  }
  const cursor = logCursor();
  const launch = restartApp(exe);
  if (!launch.started) {
    say('[5/5] could not launch TeleAgent automatically; start it manually (hook is already in place)');
    return;
  }
  const relay = await waitForRelayUrlSince(cursor, expectRelay, { timeoutMs: 45000 });
  if (relay && relay.indexOf(expectRelay) === 0) {
    say('[5/5] TeleAgent restarted, relay -> ' + relay);
  } else {
    say('[5/5] TeleAgent restarted, but the app log still shows ' + (relay || '(no relay line)'));
    say('      -> close TeleAgent completely and open it again; the hook is in place.');
  }
  say('');
  say('ready in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
  say('open TeleAgent and chat normally; traffic lands in ' + path.join(process.cwd(), 'captures', 'requests.jsonl'));
}

async function cmdDown() {
  const { config } = loadConfig(flag('config'));
  const base = bridgeBase(config);
  say('tele-proxy-bridge down');
  hookUninstall({ quiet: true });
  say('[1/4] hook removed (TeleAgent back to the official relay)');
  if (has('keep-autostart')) {
    say('[2/4] autostart kept');
  } else {
    say('[2/4] autostart ' + (removeAutostart(process.cwd()) ? 'removed' : 'was not installed'));
  }
  {
    const sd = stopSigninDaemon(process.cwd());
    say('[3/4] 每日签到守护 ' + (sd.killed ? 'stopped (pid ' + sd.pid + ')' : 'was not running'));
  }
  if (!has('no-restart') && appRunning()) {
    const exe = findAppExe();
    if (exe) {
      const cursor = logCursor();
      const expectOfficial = (config.upstreams[0] && config.upstreams[0].baseUrl) || 'https://agent.teleai.com.cn/superCowork/sapi/api/v1';
      restartApp(exe);
      // match the *exact* official url, otherwise a dying process' bridge line would be accepted
      const relay = await waitForRelayUrlSince(cursor, expectOfficial, { timeoutMs: 45000 });
      const ok = Boolean(relay && relay.indexOf(expectOfficial) === 0);
      say('[4/4] TeleAgent restarted, relay -> ' + (relay || '(log not updated yet)') + (ok ? '' : '  [expected the official relay]'));
    } else {
      say('[4/4] app running but exe not found; restart it manually');
    }
  } else {
    say('[4/4] TeleAgent not restarted');
  }
  const killed = stopDetached(process.cwd());
  say(killed.length ? 'bridge stopped (pid ' + killed.join(',') + ')' : 'bridge was not running');
}

async function cmdStatus() {
  const { config } = loadConfig(flag('config'));
  const base = bridgeBase(config);
  const rp = runtimePaths(process.cwd());
  const h = await health(base);
  const st = hookState();
  const relay = lastRelayUrl(st.paths);
  const lines = [];
  lines.push('bridge:      ' + (h ? 'UP  ' + base + '  (pid ' + (readPid(rp.pidFile) || '?') + ')' : 'DOWN'));
  if (h) {
    try {
      const stats = (await requestJson(base + '/stats', { timeoutMs: 1200 })).json;
      if (stats) lines.push('stats:       ' + JSON.stringify(stats));
    } catch {
      /* stats endpoint is optional */
    }
  }
  lines.push('hook:        ' + (st.current || '(not set)') + '   [' + st.file + ']');
  lines.push('app log:     ' + (relay || '(no relay line)'));
  lines.push('TeleAgent:   ' + (appRunning() ? 'running' : 'not running'));
  lines.push('autostart:   ' + (autostartInstalled(process.cwd()) ? 'installed' : 'off'));
  const sd = signinDaemonStatus(process.cwd());
  const signinCfg = resolveSigninConfig(config.signin || {});
  const sState = readState(process.cwd(), signinCfg);
  const todayRec = sState.days[localDateKey()];
  lines.push('签到:        daemon ' + (sd.running ? 'ON (pid ' + sd.pid + ')' : 'off') +
    '  window ' + String(Math.floor(signinCfg.window.start / 60)).padStart(2, '0') + ':' + String(signinCfg.window.start % 60).padStart(2, '0') +
    '-' + String(Math.floor(signinCfg.window.end / 60)).padStart(2, '0') + ':' + String(signinCfg.window.end % 60).padStart(2, '0') +
    '  today ' + (todayRec ? (todayRec.done ? 'done ' + String(todayRec.ranAt || '').slice(11, 16) : 'planned ' + String(todayRec.plannedAt || '').slice(11, 16)) : 'no plan'));
  const capFile = path.join(process.cwd(), 'captures', 'requests.jsonl');
  if (fs.existsSync(capFile)) {
    const size = fs.statSync(capFile).size;
    const count = fs.readFileSync(capFile, 'utf8').split('\n').filter(Boolean).length;
    lines.push('captures:    ' + count + ' request(s), ' + size + ' bytes');
    const last = fs.readFileSync(capFile, 'utf8').trim().split('\n').pop();
    try {
      const j = JSON.parse(last);
      lines.push('last:        ' + j.method + ' ' + j.path + ' -> ' + j.status + ' (' + (j.model || '?') + ')');
    } catch { /* ignore */ }
  }
  console.log(lines.join('\n'));
}

async function cmdLogs() {
  const rp = runtimePaths(process.cwd());
  const n = Number(flag('lines', '40'));
  if (!has('follow')) {
    console.log(tailFile(rp.logFile, 200000).split('\n').slice(-n).join('\n'));
    return;
  }
  let seen = fs.existsSync(rp.logFile) ? fs.statSync(rp.logFile).size : 0;
  setInterval(() => {
    if (!fs.existsSync(rp.logFile)) return;
    const size = fs.statSync(rp.logFile).size;
    if (size < seen) seen = 0;
    if (size === seen) return;
    const chunk = tailFile(rp.logFile, size - seen + 1);
    seen = size;
    process.stdout.write(chunk.split('\n').slice(1).join('\n'));
  }, 700);
}

function cmdShortcut() {
  const target = path.join(process.cwd(), 'TeleProxyBridge.cmd');
  if (!fs.existsSync(target)) throw new Error('TeleProxyBridge.cmd is missing from ' + process.cwd());
  const lnk = createDesktopShortcut({ target, args: '', name: 'TeleProxyBridge' });
  console.log('desktop shortcut: ' + lnk);
}

async function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('node', true, process.version);
  let cfg = null;
  try {
    const { config } = loadConfig(flag('config'));
    cfg = config;
    add('config', true, 'parsed, ' + config.upstreams.length + ' upstream(s)');
  } catch (err) {
    add('config', false, err.message);
  }
  const paths = findTeleAgentPaths();
  add('TeleAgent data dir', fs.existsSync(paths.localDataDir), paths.localDataDir);
  const install = findAppExe(paths);
  add('TeleAgent install', Boolean(install), install || 'not found in known locations');
  const owner = readOwner(paths.localDataDir);
  add('signed-in owner', Boolean(owner && owner.ownerDir), (owner && owner.ownerDir) || 'no current-owner.json');
  try {
    const t = resolveToken(process.cwd());
    const expMs = t.exp ? new Date(t.exp).getTime() : 0;
    const expired = expMs > 0 && expMs < Date.now();
    const src = t.source === 'app' ? '应用本地' : t.source === 'pool' ? '号池' : 'cookie';
    add('session token', !expired,
      '来源=' + src + ' tenant=' + (t.tenant || '?') + ' exp=' + (t.exp || 'unknown') + ' len=' + t.token.length);
  } catch (err) {
    add('session token', false, err.message);
  }
  try {
    const cookies = readCookies(paths);
    const keys = Object.keys(cookies).filter((k) => k.indexOf('__') !== 0);
    const cookieDetail = keys.length > 0 ? keys.join(', ') : cookies.__error || 'none';
    add('cookies', true, cookieDetail);
  } catch (err) {
    add('cookies', false, err.message);
  }
  add('hook file', true, fs.existsSync(paths.debugFile) ? paths.debugFile : paths.debugFile + ' (not installed - run "hook install")');
  if (fs.existsSync(paths.debugFile)) {
    const txt = fs.readFileSync(paths.debugFile, 'utf8');
    const m = /^\s*llmBaseUrl\s*:\s*(.+)$/m.exec(txt);
    add('llmBaseUrl override', true, m ? m[1].trim() : '(not set)');
  }
  const appLog = lastRelayUrl(paths);
  add('app relay url', Boolean(appLog), appLog || '(no relay line in main log yet)');
  if (cfg) {
    const h = await health(bridgeBase(cfg));
    add('bridge listening', Boolean(h), h ? bridgeBase(cfg) : 'not listening (run "up")');
  }
  add('autostart', true, autostartInstalled(process.cwd()) ? 'installed' : 'off');
  {
    const sd = signinDaemonStatus(process.cwd());
    const signinCfg = resolveSigninConfig((cfg && cfg.signin) || {});
    const sState = readState(process.cwd(), signinCfg);
    const todayRec = sState.days[localDateKey()];
    add('签到 daemon', true, (sd.running ? 'running pid ' + sd.pid : 'stopped') + ', today ' +
      (todayRec ? (todayRec.done ? 'done' : 'planned ' + String(todayRec.plannedAt || '').slice(11, 16)) : 'no plan'));
    if (signinCfg.enabled) {
      try {
        const rep = await runSignin({ cfg: signinCfg, dryRun: true });
        const ready = rep.tasks ? 'tasks=' + rep.tasks.length + ', claimable=' + rep.claimed.length : 'no task list';
        add('签到 endpoint', rep.ok, 'checkDayTask reachable (' + ready + ')');
      } catch (err) {
        add('签到 endpoint', false, err.message);
      }
    }
  }
  for (const c of checks) console.log((c.ok ? '[ok]   ' : '[fail] ') + c.name + ' - ' + c.detail);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

async function cmdToken() {
  const t = resolveToken(process.cwd());
  console.log('source:  ' + t.source + (t.name ? ' (' + t.name + ')' : ''));
  console.log('tenant:  ' + (t.tenant || '?'));
  if (t.exp) console.log('expires: ' + t.exp);
  const shown = has('show') ? t.token : t.token.slice(0, 18) + '... (' + t.token.length + ' chars, pass --show to print)';
  console.log('token:   ' + shown);
}

/* ---------- 每日签到 ---------- */

function signinPrintLog(log) {
  for (const l of log) console.log('  ' + l.level.padEnd(5) + ' ' + l.msg);
}

async function signinDaemonLoop(cfg) {
  for (;;) {
    let plan;
    try {
      plan = nextRunPlan({ cfg });
    } catch (err) {
      console.log('[' + localStamp() + '] plan error: ' + err.message + ' - retry in 10 min');
      await sleep(10 * 60_000);
      continue;
    }
    const when = plan.when;
    console.log('[' + localStamp() + '] next check-in ' + localStamp(when) + '  (' + plan.mode +
      ', in ' + Math.round((when.getTime() - Date.now()) / 60000) + ' min)');
    while (Date.now() < when.getTime()) {
      const left = when.getTime() - Date.now();
      await sleep(Math.min(240_000, Math.max(500, left)));
    }
    const dateKey = localDateKey();
    const attempts = recordAttempt({ cfg, dateKey });
    console.log('[' + localStamp() + '] running check-in for ' + dateKey + ' (attempt ' + attempts + ')');
    let report;
    try {
      report = await runSignin({ cfg });
    } catch (err) {
      report = { ok: false, claimed: [], log: [{ level: 'error', msg: 'runSignin threw: ' + err.message }] };
    }
    signinPrintLog(report.log);
    if (report.ok) {
      markDone({ cfg, dateKey, report });
      console.log('[' + localStamp() + '] check-in done (claimed=' + report.claimed.length + ')');
    } else if (attempts >= 4) {
      markSkipped({ cfg, dateKey, reason: 'four failed attempts: ' + (report.tokenExpired ? 'token expired' : 'see log') });
      console.log('[' + localStamp() + '] giving up for ' + dateKey + ' after ' + attempts + ' attempts; next try tomorrow');
    } else {
      console.log('[' + localStamp() + '] check-in failed; will retry later today');
    }
    await sleep(5_000);
  }
}

async function cmdSignin() {
  const { config } = loadConfig(flag('config'));
  const cfg = resolveSigninConfig(config.signin || {}, flag('window'));

  if (has('status')) {
    const d = signinDaemonStatus(process.cwd());
    const state = readState(process.cwd(), cfg);
    const today = state.days[localDateKey()];
    console.log('daemon:    ' + (d.running ? 'running (pid ' + d.pid + ')' : 'stopped'));
    console.log('log:       ' + d.logFile);
    console.log('window:    ' + String(Math.floor(cfg.window.start / 60)).padStart(2, '0') + ':' + String(cfg.window.start % 60).padStart(2, '0') +
      ' - ' + String(Math.floor(cfg.window.end / 60)).padStart(2, '0') + ':' + String(cfg.window.end % 60).padStart(2, '0'));
    console.log('today:     ' + (today ? (today.done ? 'done at ' + today.ranAt : 'planned for ' + today.plannedAt) : 'no plan yet'));
    const keys = Object.keys(state.days).sort().slice(-7);
    if (keys.length) {
      console.log('last days:');
      for (const k of keys) {
        const r = state.days[k];
        console.log('  ' + k + '  ' + (r.done ? 'done' : r.skipped ? 'skipped' : 'pending') + '  planned=' + String(r.plannedAt || '-').slice(11, 16) +
          (r.results && r.results.length ? '  ' + r.results.map((x) => (x.apiPath || '') + ':' + (x.code || x.status)).join(',') : ''));
      }
    }
    return;
  }

  if (has('stop')) {
    const r = stopSigninDaemon(process.cwd());
    console.log(r.killed ? 'signin daemon stopped (pid ' + r.pid + ')' : 'signin daemon was not running');
    return;
  }

  if (has('start')) {
    const r = startSigninDaemon({ root: process.cwd() });
    console.log(r.already ? 'signin daemon already running (pid ' + r.pid + ')' : 'signin daemon started (pid ' + r.pid + ', log ' + r.logFile + ')');
    return;
  }

  if (has('daemon')) {
    await signinDaemonLoop(cfg);
    return;
  }

  if (!cfg.enabled && !has('force')) {
    console.log('signin disabled in config (signin.enabled=false); pass --force to run anyway');
    return;
  }

  const dateKey = localDateKey();
  const state = readState(process.cwd(), cfg);
  const rec = state.days[dateKey];
  if (rec && rec.done && !has('force')) {
    console.log('今天（' + dateKey + '）已经签到过: ' + (rec.ranAt || '') + '; 加 --force 可再跑一次');
    return;
  }

  let info = null;
  try { info = tokenInfo(resolveToken(process.cwd()).token); } catch { /* reported by runSignin */ }
  if (info && info.exp) console.log('token exp: ' + info.exp.toISOString() + '  tenant=' + (info.tenant || '?'));

  const t0 = Date.now();
  const report = await runSignin({ cfg, dryRun: has('dry-run') });
  signinPrintLog(report.log);
  if (!has('dry-run') && (report.ok || report.claimed.length)) {
    markDone({ cfg, dateKey, report });
  }
  console.log('');
  console.log((report.ok ? 'ok' : 'failed') + ' - ' + report.claimed.length + ' claim(s), ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' +
    (has('dry-run') ? '  [dry-run]' : ''));
  if (!report.ok) process.exitCode = 1;
}

/* ---------- autostart toggle ---------- */

async function cmdAutostart() {
  const action = rest[0] || 'status';
  if (action === 'on') {
    const r = ensureAutostart({ root: process.cwd() });
    console.log('autostart on: ' + r.registry);
    return;
  }
  if (action === 'off') {
    const had = removeAutostart(process.cwd());
    console.log(had ? 'autostart removed' : 'autostart was not installed');
    return;
  }
  if (action === 'status') {
    console.log('autostart: ' + (autostartInstalled() ? 'on' : 'off'));
    return;
  }
  console.error('usage: tele-proxy-bridge autostart [on|off|status]');
  process.exitCode = 1;
}

/* ---------- control panel ---------- */

/** Opens the dashboard in a chromeless Edge window when possible (looks like a native app). */
function openPanel(url) {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  const edge = candidates.find((p) => fs.existsSync(p));
  if (edge) {
    spawn(edge, ['--app=' + url, '--window-size=1180,900'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'edge app 窗口';
  }
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return '默认浏览器';
}

async function cmdUi() {
  const { config } = loadConfig(flag('config'));
  const base = bridgeBase(config);
  if (!(await health(base))) {
    say('bridge 未运行，先启动…');
    startDetached({ root: process.cwd(), configFile: flag('config') });
    const ready = await waitForHealth(base, 20000);
    if (!ready) throw new Error('bridge 启动失败，看 bridge.log');
    say('bridge 就绪: ' + base);
  }
  const url = base + '/ui';
  say('控制台: ' + url + '  (' + openPanel(url) + ')');
}

/* ---------- uninstall ---------- */

function shortcutTargets() {
  const home = process.env.USERPROFILE || os.homedir();
  const list = [
    path.join(home, 'Desktop', 'TeleProxyBridge.lnk'),
    'C:/Users/Public/Desktop/TeleProxyBridge.lnk'
  ];
  if (process.env.APPDATA) {
    list.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TeleProxyBridge.lnk'));
  }
  return list;
}

async function cmdUninstall() {
  const root = process.cwd();
  const shortcuts = shortcutTargets();
  if (!has('yes')) {
    console.log('卸载预演（不会改动任何东西）。将执行:');
    console.log('  1. 停止签到守护 / 中继进程');
    console.log('  2. 删除开机自启（HKCU Run）');
    console.log('  3. 还原 TeleAgent 的 llmBaseUrl（回到官方中转）');
    console.log('  4. 删除快捷方式:');
    shortcuts.forEach((s) => console.log('       ' + s));
    console.log('  5. 删除目录: ' + root);
    console.log('');
    console.log('确认请运行: node src/cli.mjs uninstall --yes');
    return;
  }
  const steps = [];
  try { steps.push('signin daemon: ' + (stopSigninDaemon(root).killed ? 'stopped' : 'not running')); } catch (err) { steps.push('signin daemon: ' + err.message); }
  try { steps.push('bridge: ' + (stopDetached(root).length ? 'stopped' : 'not running')); } catch (err) { steps.push('bridge: ' + err.message); }
  try { steps.push('autostart: ' + (removeAutostart(root) ? 'removed' : 'was off')); } catch (err) { steps.push('autostart: ' + err.message); }
  try { steps.push('hook: ' + (hookUninstall({ quiet: true }).restored ? 'restored' : 'nothing to restore')); } catch (err) { steps.push('hook: ' + err.message); }
  let removed = 0;
  for (const s of shortcuts) {
    try { fs.unlinkSync(s); removed += 1; } catch { /* not there */ }
  }
  steps.push('shortcuts: ' + removed + ' removed');
  // Anything launched from this directory that outlived its pid file (wmic is gone on Win11 24H2+, so use CIM).
  try {
    const { execFileSync } = await import('node:child_process');
    const safeRoot = root.replace(/'/g, "''");
    const ps = "$p = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" + safeRoot + "*' }); $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
    const n = Number(out);
    if (Number.isFinite(n) && n > 0) steps.push('processes: ' + n + ' stopped');
  } catch { /* best effort */ }
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeleProxyBridge', '/f'], { stdio: 'ignore', windowsHide: true });
    steps.push('uninstall entry: removed');
  } catch { /* nothing registered */ }
  steps.forEach((s) => console.log('  ' + s));
  console.log('  restart TeleAgent manually so it drops the local relay');
  // This process is node.exe from the install dir, so the folder can only go away after we exit:
  // hand the retry loop to a detached script instead of a single fixed delay.
  const script = path.join(os.tmpdir(), 'tpb-cleanup-' + Date.now() + '.cmd');
  const body = [
    '@echo off',
    'setlocal',
    'set DIR=' + root,
    'set N=0',
    ':loop',
    'ping -n 3 127.0.0.1 >nul',
    'rmdir /s /q "%DIR%" 2>nul',
    'if not exist "%DIR%" goto done',
    'set /a N+=1',
    'if %N% GEQ 20 goto done',
    'goto loop',
    ':done',
    'del "%~f0" >nul 2>&1'
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(script, body, 'utf8');
  spawn('cmd', ['/c', script], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log('deleting ' + root + ' ...');
}

const commands = {
  serve: cmdServe, init: cmdInit, doctor: cmdDoctor, token: cmdToken, hook: cmdHook,
  up: cmdUp, down: cmdDown, status: cmdStatus, logs: cmdLogs, shortcut: cmdShortcut, signin: cmdSignin,
  ui: cmdUi, uninstall: cmdUninstall, autostart: cmdAutostart
};
const run = commands[command];
if (!run) {
  console.error('usage: tele-proxy-bridge <up|down|status|logs|ui|serve|init|doctor|token|hook|signin|shortcut|uninstall>');
  console.error('  signin [--status|--start|--stop|--daemon|--dry-run|--force] [--window 08:20-11:40]');
  process.exit(1);
}
await run();
