// TeleAgent.exe 的可移植定位：环境变量 -> 注册表卸载项 -> 常见安装目录 -> PATH
// 不写死任何个人路径，别的电脑装到哪个盘都能找到。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXE = 'TeleAgent.exe';
const WIN = process.platform === 'win32';

const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
];

function fromRegistry() {
  if (!WIN) return [];
  const found = [];
  for (const root of UNINSTALL_ROOTS) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'TeleAgent', '/t', 'REG_SZ'], {
        encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(DisplayIcon|InstallLocation)\s+REG_SZ\s+(.+?)\s*$/i.exec(line);
      if (!m) continue;
      let p = m[2].replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '');
      if (!p) continue;
      found.push(/\.exe$/i.test(p) ? p : path.join(p, EXE));
    }
  }
  return found;
}

function fromStandardDirs(env) {
  const bases = [];
  const push = (p) => { if (p) bases.push(p); };
  if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'Programs'));
  if (env.LOCALAPPDATA) push(env.LOCALAPPDATA);
  if (env.ProgramFiles) push(env.ProgramFiles);
  if (env['ProgramFiles(x86)']) push(env['ProgramFiles(x86)']);
  push('C:\\Program Files');
  return bases.map((b) => path.join(b, 'TeleAgent', EXE));
}

function fromPath(env) {
  if (!WIN) return [];
  try {
    const out = execFileSync('where', [EXE], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function candidateExePaths(env = process.env) {
  const list = [];
  const add = (p) => {
    if (!p) return;
    const n = path.normalize(p);
    if (!list.some((x) => x.toLowerCase() === n.toLowerCase())) list.push(n);
  };
  add(env.TELEAGENT_EXE);
  for (const p of fromRegistry()) add(p);
  for (const p of fromStandardDirs(env)) add(p);
  for (const p of fromPath(env)) add(p);
  return list;
}

export function findExe(env = process.env) {
  for (const p of candidateExePaths(env)) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* keep looking */ }
  }
  return null;
}
