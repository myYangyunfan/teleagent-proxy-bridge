import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findTeleAgentPaths } from './teleagent/credentials.mjs';

export const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));

export function runtimePaths(root = process.cwd()) {
  return {
    root,
    pidFile: path.join(root, '.tpb.pid'),
    logFile: path.join(root, 'bridge.log'),
    signinPidFile: path.join(root, '.signin.pid'),
    signinLogFile: path.join(root, 'signin.log')
  };
}

export function requestJson(url, { method = 'GET', timeoutMs = 1500, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method, headers, timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function health(baseUrl) {
  try {
    const res = await requestJson(baseUrl + '/health', { timeoutMs: 1200 });
    if (res.status === 200 && res.json && res.json.ok) return res.json;
    return null;
  } catch {
    return null;
  }
}

export async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health(baseUrl);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export function readPid(pidFile) {
  try {
    const n = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function startDetached({ root = process.cwd(), configFile = null, logFile }) {
  const rp = runtimePaths(root);
  const log = logFile || rp.logFile;
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, '\n=== ' + new Date().toISOString() + ' starting bridge ===\n');
  const args = [CLI_PATH, 'serve'];
  if (configFile) args.push('--config', configFile);
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: process.env
  });
  child.unref();
  fs.writeFileSync(rp.pidFile, String(child.pid), 'utf8');
  return { pid: child.pid, logFile: log };
}

export function stopDetached(root = process.cwd()) {
  const rp = runtimePaths(root);
  const pid = readPid(rp.pidFile);
  const killed = [];
  if (pid && isProcessAlive(pid)) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      killed.push(pid);
    } catch {
      /* already gone */
    }
  }
  try { fs.unlinkSync(rp.pidFile); } catch { /* ignore */ }
  return killed;
}

/** Daily check-in daemon: node cli.mjs signin --daemon, detached, logs to signin.log. */
export function startSigninDaemon({ root = process.cwd(), extraArgs = [], logFile } = {}) {
  const rp = runtimePaths(root);
  const existing = readPid(rp.signinPidFile);
  if (existing && isProcessAlive(existing)) return { pid: existing, already: true, logFile: logFile || rp.signinLogFile };
  const log = logFile || rp.signinLogFile;
  const fd = fs.openSync(log, 'a');
  fs.writeSync(fd, '\n=== ' + new Date().toISOString() + ' starting signin daemon ===\n');
  const child = spawn(process.execPath, [CLI_PATH, 'signin', '--daemon', ...extraArgs], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: process.env
  });
  child.unref();
  fs.writeFileSync(rp.signinPidFile, String(child.pid), 'utf8');
  return { pid: child.pid, already: false, logFile: log };
}

export function stopSigninDaemon(root = process.cwd()) {
  const rp = runtimePaths(root);
  const pid = readPid(rp.signinPidFile);
  let killed = false;
  if (pid && isProcessAlive(pid)) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
      killed = true;
    } catch {
      /* already gone */
    }
  }
  try { fs.unlinkSync(rp.signinPidFile); } catch { /* ignore */ }
  return { killed, pid };
}

export function signinDaemonStatus(root = process.cwd()) {
  const rp = runtimePaths(root);
  const pid = readPid(rp.signinPidFile);
  return { pid, running: !!(pid && isProcessAlive(pid)), logFile: rp.signinLogFile };
}

export function tailFile(file, bytes = 4000) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/* ---------------- TeleAgent app control ---------------- */

export function findAppExe(paths = findTeleAgentPaths()) {
  return paths.installCandidates.find((p) => fs.existsSync(p)) || null;
}

export function appRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq TeleAgent.exe', '/NH'], {
      encoding: 'utf8', windowsHide: true
    });
    return /TeleAgent\.exe/i.test(out);
  } catch {
    return false;
  }
}

export function killApp() {
  if (process.platform !== 'win32') return;
  try {
    execFileSync('taskkill', ['/IM', 'TeleAgent.exe', '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* not running */
  }
}

export function startApp(exe) {
  // Electron ignores a plain spawn() from a detached node child (the app never shows up),
  // so launch it the same way a desktop user would.
  const script = 'Start-Process -FilePath "' + exe + '" -WorkingDirectory "' + path.dirname(exe) + '"';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: 'ignore', windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

export function restartApp(exe, { settleMs = 2500 } = {}) {
  killApp();
  const startedAt = Date.now();
  const deadline = startedAt + settleMs;
  while (Date.now() < deadline && appRunning()) {
    try { execFileSync('cmd', ['/c', 'timeout', '/t', '1', '/nobreak'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  const started = startApp(exe);
  return { started, startedAt };
}

/** Newest Electron main log; the relay URLs are logged there by ServerManager. */
export function newestMainLog(paths = findTeleAgentPaths()) {
  const dir = path.join(paths.localDataDir, 'logs');
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^main-.*\.log$/i.test(name)) continue;
      const full = path.join(dir, name);
      const mtime = fs.statSync(full).mtimeMs;
      if (!best || mtime > best.mtimeMs) best = { file: full, mtimeMs: mtime };
    }
  } catch {
    return null;
  }
  return best;
}

/** Marks the end of the current main log so we only trust lines written after a restart. */
export function logCursor(paths = findTeleAgentPaths()) {
  const log = newestMainLog(paths);
  if (!log) return null;
  try {
    return { file: log.file, size: fs.statSync(log.file).size };
  } catch {
    return null;
  }
}

function readFrom(file, offset) {
  try {
    const st = fs.statSync(file);
    const from = st.size > offset ? offset : 0;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function relayUrlSince(cursor, paths = findTeleAgentPaths()) {
  const log = newestMainLog(paths);
  if (!log) return null;
  const same = cursor && cursor.file === log.file;
  const text = readFrom(log.file, same ? cursor.size : 0);
  const idx = text.lastIndexOf('Effective model relay URLs');
  if (idx < 0) return null;
  const m = /newApiBaseUrl:\s*'([^']+)'/.exec(text.slice(idx, idx + 4000));
  return m ? m[1] : null;
}

export async function waitForRelayUrlSince(cursor, expect, { paths = findTeleAgentPaths(), timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = relayUrlSince(cursor, paths);
    if (url && (!expect || url.includes(expect))) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  return relayUrlSince(cursor, paths);
}

export function lastRelayUrl(paths = findTeleAgentPaths()) {
  const log = newestMainLog(paths);
  if (!log) return null;
  const tail = tailFile(log.file, 60000);
  const idx = tail.lastIndexOf('Effective model relay URLs');
  if (idx < 0) return null;
  const chunk = tail.slice(idx, idx + 4000);
  const m = /newApiBaseUrl:\s*'([^']+)'/.exec(chunk);
  return m ? m[1] : null;
}

export async function waitForRelayUrl(expect, { paths = findTeleAgentPaths(), timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = lastRelayUrl(paths);
    if (url && (!expect || url.includes(expect))) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  return lastRelayUrl(paths);
}

/* ---------------- autostart (HKCU Run + hidden VBS in the project dir) ---------------- */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'TeleProxyBridge';

function reg(args) {
  try {
    const out = execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim();
  } catch (err) {
    return null;
  }
}

export function autostartCommand({ root = process.cwd(), nodeExe = process.execPath } = {}) {
  return 'wscript.exe "' + path.join(root, 'autostart.vbs') + '"';
}

/** Writes autostart.vbs (hidden launcher) and registers it in HKCU Run. */
export function ensureAutostart({ root = process.cwd(), nodeExe = process.execPath } = {}) {
  const vbsFile = path.join(root, 'autostart.vbs');
  const q = (s) => 'Chr(34) & "' + String(s).replace(/"/g, '""') + '" & Chr(34)';
  const vbs = [
    "' TeleProxyBridge autostart: boots the local bridge hidden, keeps the TeleAgent hook pointing at it",
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + root + '"',
    'cmd = ' + q(nodeExe) + ' & " " & ' + q(CLI_PATH) + ' & " up --quiet --no-restart --no-autostart"',
    'sh.Run cmd, 0, False'
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(vbsFile, vbs, 'utf8');
  const value = 'wscript.exe "' + vbsFile + '"';
  const ok = reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', value, '/f']);
  if (ok === null) throw new Error('could not write ' + RUN_KEY + ' (registry access denied)');
  return { file: vbsFile, registry: RUN_NAME + ' = ' + value };
}

export function removeAutostart(root = process.cwd()) {
  const had = autostartInstalled(root);
  reg(['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
  try { fs.unlinkSync(path.join(root, 'autostart.vbs')); } catch { /* ignore */ }
  return had;
}

export function autostartInstalled() {
  const out = reg(['query', RUN_KEY, '/v', RUN_NAME]);
  return Boolean(out && out.indexOf(RUN_NAME) >= 0);
}

/* ---------------- desktop shortcut ---------------- */

export function createDesktopShortcut({ target, args = '', name = 'TeleProxyBridge' }) {
  if (process.platform !== 'win32') throw new Error('shortcut creation is Windows-only');
  const script = [
    '$desktop = [Environment]::GetFolderPath("Desktop")',
    '$lnk = Join-Path $desktop "' + name + '.lnk"',
    '$sh = New-Object -ComObject WScript.Shell',
    '$s = $sh.CreateShortcut($lnk)',
    '$s.TargetPath = "' + target + '"',
    '$s.Arguments = "' + args + '"',
    '$s.WorkingDirectory = "' + path.dirname(target) + '"',
    '$s.IconLocation = "' + target + ',0"',
    '$s.Save()',
    'Write-Output $lnk'
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', windowsHide: true
  });
  return out.trim();
}