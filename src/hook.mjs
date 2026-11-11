import fs from 'node:fs';
import path from 'node:path';
import { findTeleAgentPaths } from './teleagent/credentials.mjs';

/* ---------- hook (internal-debug.yaml llmBaseUrl) ----------
 * The app resolves its relay as `(llmBaseUrl || DEFAULT) + '/api/v1'` and signs the
 * URL it dials, so the hook value MUST keep the /superCowork/sapi prefix.
 */

export function hookState() {
  const paths = findTeleAgentPaths();
  const file = paths.debugFile;
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const m = /^\s*llmBaseUrl\s*:\s*(.+)$/m.exec(text);
  return { paths, file, exists, text, current: m ? m[1].trim() : null };
}

export function hookInstall(url, { quiet = false } = {}) {
  const st = hookState();
  const lines = st.exists ? st.text.split(/\r?\n/) : [];
  // The backup must always be the hook-free original: re-installing over an older hook
  // used to snapshot the old override and resurrect it on "down".
  const clean = lines.filter((l) => !/^\s*llmBaseUrl\s*:/.test(l));
  const backup = st.file + '.tpb-backup';
  if (st.exists) {
    const previous = fs.existsSync(backup) ? fs.readFileSync(backup, 'utf8') : null;
    if (previous === null || /^\s*llmBaseUrl\s*:/m.test(previous)) {
      fs.writeFileSync(backup, clean.join('\n'), 'utf8');
    }
  }
  if (st.exists && st.current === url) {
    if (!quiet) console.log('hook already points at ' + url);
    return { file: st.file, changed: false, url };
  }
  const next = clean.filter((l) => l.trim() !== '');
  next.push('llmBaseUrl: ' + url);
  // 全新机器上应用可能还没写过这个文件，目录也不存在
  fs.mkdirSync(path.dirname(st.file), { recursive: true });
  fs.writeFileSync(st.file, next.join('\n') + '\n', 'utf8');
  if (!quiet) console.log('hook installed: llmBaseUrl = ' + url);
  return { file: st.file, changed: true, url };
}

export function hookUninstall({ quiet = false } = {}) {
  const st = hookState();
  const backup = st.file + '.tpb-backup';
  if (fs.existsSync(backup)) {
    fs.writeFileSync(st.file, fs.readFileSync(backup, 'utf8'), 'utf8');
    fs.unlinkSync(backup);
    if (!quiet) console.log('restored original ' + st.file);
    return { file: st.file, restored: true };
  }
  if (!st.exists) {
    if (!quiet) console.log('nothing to restore');
    return { file: st.file, restored: false };
  }
  const next = st.text.split(/\r?\n/).filter((l) => !/^\s*llmBaseUrl\s*:/.test(l));
  fs.writeFileSync(st.file, next.join('\n'), 'utf8');
  if (!quiet) console.log('removed llmBaseUrl override from ' + st.file);
  return { file: st.file, restored: true };
}

export function hookUrlFor(config) {
  const host = config.listen.host === '0.0.0.0' ? '127.0.0.1' : config.listen.host;
  const base = 'http://' + host + ':' + config.listen.port;
  const p = String(config.hookPath || '').replace(/\/+$/, '');
  if (!p) return base;
  return base + (p.startsWith('/') ? p : '/' + p);
}
