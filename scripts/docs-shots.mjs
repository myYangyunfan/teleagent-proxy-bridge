// 用合成数据重新渲染 README 里的面板截图（不含任何真实账号信息）。
// 用法: node scripts/docs-shots.mjs   -> 覆盖 docs/panel*.png
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'docs');
const PORT = 8791;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find((p) => fs.existsSync(p));

// 敏感值不写死在这里（这份脚本也要进公开仓库）：运行时从 live state 里取，
// 再把自己取到的那些值替换成演示值。
let RULES = [];
function buildRules(state) {
  const rules = [];
  const accounts = state?.accounts || [];
  const tenant = state?.token?.tenant || accounts[0]?.tenant;
  const userId = String(accounts[0]?.userId || state?.token?.userId || '');
  if (tenant) rules.push([new RegExp(tenant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'DEMO01']);
  if (userId) {
    rules.push([new RegExp(userId, 'g'), '1000123456789012345']);
    const tail = userId.slice(-6);
    if (tail) rules.push([new RegExp(tail, 'g'), '345678']);
  }
  const user = (os.userInfo && os.userInfo().username) || '';
  if (user) rules.push([new RegExp(user, 'gi'), 'demo']);
  return rules;
}

function scrub(value) {
  if (typeof value === 'string') return RULES.reduce((s, [re, to]) => s.replace(re, to), value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url);
  return r.text();
}

const rawState = await getJson('http://127.0.0.1:8787/admin/state');
RULES = buildRules(rawState);
const state = scrub(rawState);
const logs = {
  bridge: scrub(await getText('http://127.0.0.1:8787/admin/logs?which=bridge&bytes=20000')),
  signin: scrub(await getText('http://127.0.0.1:8787/admin/logs?which=signin&bytes=20000'))
};
// 演示数据：把真实账号换成合成账号，避免截图里出现任何真实标识
state.accounts = (state.accounts || []).map((a, i) => ({
  ...a,
  id: 'acc_demo' + (i + 1),
  name: 'demo-account',
  tenant: 'DEMO01',
  userId: '1000123456789012345',
  enabled: true,
  points: 4280,
  expiresInDays: 42
}));
// 面板顶部那张卡片读的是 token.tenant（顶层），不是 payload.tenant
state.token = {
  ok: true, source: 'pool', tenant: 'DEMO01', userId: '1000123456789012345',
  exp: '2027-01-01T00:00:00.000Z',
  payload: { tenant: 'DEMO01', userId: '1000123456789012345', exp: '2027-01-01T00:00:00.000Z' }
};
state.points = 4280;
if (state.app) state.app = { ...state.app, running: true };
if (Array.isArray(state.captures?.items)) {
  state.captures.items = state.captures.items.map((c) => ({ ...c, path: '/demo' + String(c.path || '').replace(/^.*?(\/api\/v1)/, '$1') }));
}

const html = fs.readFileSync(path.join(ROOT, 'src/webui/index.html'), 'utf8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/admin/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }
  if (url.pathname === '/admin/logs') {
    const which = url.searchParams.get('which') === 'signin' ? 'signin' : 'bridge';
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(logs[which]);
    return;
  }
  if (url.pathname === '/ui' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('no');
});

function shot(url, file, size) {
  return new Promise((resolve, reject) => {
    const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=7000',
      '--window-size=' + size, '--screenshot=' + file, url];
    const p = spawn(EDGE, args, { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('edge exit ' + code))));
    p.on('error', reject);
  });
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + PORT + '/ui';
const jobs = [
  ['?page=overview', path.join(OUT, 'panel.png'), '1280,900'],
  ['?page=pool', path.join(OUT, 'panel-pool.png'), '1280,600'],
  ['?page=models', path.join(OUT, 'panel-models.png'), '1280,520'],
  ['?page=keys', path.join(OUT, 'panel-keys.png'), '1280,560']
];
for (const [qs, file, size] of jobs) {
  await shot(base + qs, file, size);
  console.log('shot ' + path.basename(file));
}
server.close();
console.log('done');
