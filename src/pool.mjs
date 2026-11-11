// 号池 / 模型 / 本地密钥 的持久化与业务逻辑（零依赖）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readAppToken } from './teleagent/credentials.mjs';

const DEFAULT_FILE = 'data/pool.json';

export function poolPaths(root) {
  const file = path.resolve(root, DEFAULT_FILE);
  return { dir: path.dirname(file), file };
}

function blank() {
  return { version: 1, accounts: [], keys: [], models: { aliases: {}, disabled: [] } };
}

export function loadPool(root) {
  const { file } = poolPaths(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = blank();
    if (Array.isArray(raw.accounts)) data.accounts = raw.accounts.filter((a) => a && a.token);
    if (Array.isArray(raw.keys)) data.keys = raw.keys.filter((k) => k && k.key);
    if (raw.models && typeof raw.models === 'object') {
      data.models.aliases = raw.models.aliases && typeof raw.models.aliases === 'object' ? raw.models.aliases : {};
      data.models.disabled = Array.isArray(raw.models.disabled) ? raw.models.disabled : [];
    }
    return data;
  } catch {
    return blank();
  }
}

export function savePool(root, data) {
  const { dir, file } = poolPaths(root);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/* ---------------------------- token ---------------------------- */

export function decodeToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return {
      tenant: json.tenant || json.tenantId || null,
      userId: json.userId || json.uid || json.sub || null,
      exp: json.exp ? new Date(json.exp * 1000).toISOString() : null,
      raw: json
    };
  } catch {
    return null;
  }
}

function expiryDays(exp) {
  if (!exp) return null;
  return Math.round((new Date(exp).getTime() - Date.now()) / 86400000);
}

/* ---------------------------- accounts ---------------------------- */

export function listAccounts(root) {
  const pool = loadPool(root);
  return pool.accounts.map((a) => {
    const info = decodeToken(a.token);
    return {
      id: a.id,
      name: a.name || (info && info.userId) || a.id,
      tenant: a.tenant || (info && info.tenant) || null,
      userId: a.userId || (info && info.userId) || null,
      exp: a.exp || (info && info.exp) || null,
      expiresInDays: expiryDays(a.exp || (info && info.exp)),
      enabled: a.enabled !== false,
      addedAt: a.addedAt || null,
      lastProbe: a.lastProbe || null
    };
  });
}

export function addAccount(root, { name, token, enabled = true }) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('token 不能为空');
  const info = decodeToken(clean);
  if (!info) throw new Error('token 不是合法 JWT，解不出 tenant / userId');
  const pool = loadPool(root);
  const existing = pool.accounts.find((a) => a.userId === info.userId && a.tenant === info.tenant);
  const rec = {
    id: existing ? existing.id : 'acc_' + crypto.randomBytes(4).toString('hex'),
    name: name || (existing && existing.name) || info.userId,
    tenant: info.tenant,
    userId: info.userId,
    exp: info.exp,
    token: clean,
    enabled,
    addedAt: existing ? existing.addedAt : new Date().toISOString(),
    lastProbe: existing ? existing.lastProbe : null
  };
  if (existing) pool.accounts = pool.accounts.map((a) => (a.id === existing.id ? rec : a));
  else pool.accounts.push(rec);
  savePool(root, pool);
  return listAccounts(root).find((a) => a.id === rec.id);
}

export function removeAccount(root, id) {
  const pool = loadPool(root);
  const before = pool.accounts.length;
  pool.accounts = pool.accounts.filter((a) => a.id !== id);
  savePool(root, pool);
  return { removed: before - pool.accounts.length };
}

export function toggleAccount(root, id, enabled) {
  const pool = loadPool(root);
  const acc = pool.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('账号不存在: ' + id);
  acc.enabled = !!enabled;
  savePool(root, pool);
  return { id, enabled: acc.enabled };
}

export function accountToken(root, id) {
  const pool = loadPool(root);
  const acc = pool.accounts.find((a) => a.id === id);
  return acc ? acc.token : null;
}

export function primaryAccount(root) {
  const pool = loadPool(root);
  const acc = pool.accounts.find((a) => a.enabled !== false && a.token) || pool.accounts[0];
  return acc || null;
}

/** 把当前 TeleAgent 客户端里已登录的账号导进号池 */
export function importFromTeleAgent(root) {
  const t = readAppToken();
  const info = decodeToken(t.token);
  if (!info) throw new Error('读到的 token 解不出来');
  return addAccount(root, { name: 'TeleAgent · ' + (info.userId || '').slice(-6), token: t.token });
}

/* ---------------------------- keys ---------------------------- */

export function listKeys(root) {
  const pool = loadPool(root);
  return pool.keys.map((k) => ({
    id: k.id,
    label: k.label || '未命名',
    masked: maskKey(k.key),
    createdAt: k.createdAt || null,
    enabled: k.enabled !== false,
    limit: k.limit == null ? null : Number(k.limit),
    used: Number(k.used || 0),
    lastUsedAt: k.lastUsedAt || null
  }));
}

function maskKey(k) {
  const s = String(k || '');
  return s.length <= 12 ? s : s.slice(0, 8) + '…' + s.slice(-4);
}

export function createKey(root, { label, limit = null }) {
  const pool = loadPool(root);
  const key = 'sk-tpb-' + crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, '').slice(0, 32);
  const rec = {
    id: 'key_' + crypto.randomBytes(4).toString('hex'),
    label: label || 'key ' + (pool.keys.length + 1),
    key,
    createdAt: new Date().toISOString(),
    enabled: true,
    limit: limit == null || limit === '' ? null : Number(limit),
    used: 0,
    lastUsedAt: null
  };
  pool.keys.push(rec);
  savePool(root, pool);
  return { id: rec.id, label: rec.label, key, limit: rec.limit };
}

export function revokeKey(root, id) {
  const pool = loadPool(root);
  const before = pool.keys.length;
  pool.keys = pool.keys.filter((k) => k.id !== id);
  savePool(root, pool);
  return { removed: before - pool.keys.length };
}

export function toggleKey(root, id, enabled) {
  const pool = loadPool(root);
  const k = pool.keys.find((x) => x.id === id);
  if (!k) throw new Error('密钥不存在: ' + id);
  k.enabled = !!enabled;
  savePool(root, pool);
  return { id, enabled: k.enabled };
}

/** 校验客户端带来的 key：号池里的活跃 key 或配置里的静态 key 都行 */
export function resolveKey(root, presented, staticKeys = []) {
  const raw = String(presented || '').trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (staticKeys.includes(raw)) return { ok: true, source: 'config', id: null };
  const pool = loadPool(root);
  const hit = pool.keys.find((k) => k.key === raw);
  if (!hit) return { ok: false, reason: 'unknown' };
  if (hit.enabled === false) return { ok: false, reason: 'disabled' };
  if (hit.limit != null && Number(hit.used || 0) >= Number(hit.limit)) return { ok: false, reason: 'quota' };
  return { ok: true, source: 'pool', id: hit.id, label: hit.label };
}

export function recordKeyUsage(root, id, n = 1) {
  if (!id) return;
  const pool = loadPool(root);
  const k = pool.keys.find((x) => x.id === id);
  if (!k) return;
  k.used = Number(k.used || 0) + n;
  k.lastUsedAt = new Date().toISOString();
  savePool(root, pool);
}

/* ---------------------------- models ---------------------------- */

export function getModels(root, baseModels = []) {
  const pool = loadPool(root);
  const disabled = new Set(pool.models.disabled);
  const list = Array.from(new Set([...(baseModels || []), ...Object.keys(pool.models.aliases || {})]));
  return list.map((name) => ({
    name,
    alias: pool.models.aliases?.[name] || null,
    enabled: !disabled.has(name)
  }));
}

export function setAlias(root, name, target) {
  const pool = loadPool(root);
  if (!name) throw new Error('模型名不能为空');
  if (target) pool.models.aliases[name] = String(target);
  else delete pool.models.aliases[name];
  savePool(root, pool);
  return pool.models.aliases;
}

export function toggleModel(root, name, enabled) {
  const pool = loadPool(root);
  const set = new Set(pool.models.disabled);
  if (enabled) set.delete(name);
  else set.add(name);
  pool.models.disabled = Array.from(set);
  savePool(root, pool);
  return { name, enabled };
}

/* ---------------------------- probe ---------------------------- */

export async function probeAccount(root, id, cfg) {
  const pool = loadPool(root);
  const acc = pool.accounts.find((a) => a.id === id);
  if (!acc) throw new Error('账号不存在: ' + id);
  const origin = String(cfg.origin || '').replace(/\/+$/, '');
  const prefix = String(cfg.apiPrefix || '');
  const headers = { 'x-token': acc.token, 'user-agent': cfg.userAgent || 'SuperAgent/1.0', theme: 'light' };
  const out = { at: new Date().toISOString(), ok: false, points: null, tasks: 0, claimed: 0, error: null };
  try {
    const dres = await fetch(origin + prefix + '/user/portal/companyStore/v3/checkDayTask?theme=light', {
      headers, signal: AbortSignal.timeout(12000)
    });
    const body = await dres.json();
    const list = (body && body.data && body.data.activity_data) || [];
    out.tasks = Array.isArray(list) ? list.length : 0;
    out.claimed = (Array.isArray(list) ? list : []).filter((t) => t.status === 'completed' || t.action_text === '今日已领').length;
    out.ok = dres.ok;
    const pres = await fetch(origin + prefix + '/user/portal/points/detail', {
      headers, signal: AbortSignal.timeout(12000)
    });
    const pbody = await pres.json();
    const pdata = (pbody && (pbody.data || pbody)) || {};
    out.points = pdata.pointsBalance ?? pdata.pointBalance ?? null;
  } catch (err) {
    out.error = err.message;
  }
  acc.lastProbe = out;
  if (out.ok) acc.exp = decodeToken(acc.token)?.exp || acc.exp;
  savePool(root, pool);
  return out;
}

export function poolSummary(root) {
  const pool = loadPool(root);
  const accounts = listAccounts(root);
  return {
    accounts: accounts.length,
    enabledAccounts: accounts.filter((a) => a.enabled).length,
    keys: pool.keys.length,
    activeKeys: pool.keys.filter((k) => k.enabled !== false).length,
    totalUsed: pool.keys.reduce((s, k) => s + Number(k.used || 0), 0)
  };
}
