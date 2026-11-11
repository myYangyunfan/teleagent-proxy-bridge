// 会话 token 的解析顺序：应用本地 token -> Chromium cookie -> 号池里的账号。
// 应用换存储格式、或者干脆没登录时，只要号池里有一个号，功能就不会全瘫。
import { readAppToken, readCookies } from './teleagent/credentials.mjs';
import { primaryAccount, decodeToken } from './pool.mjs';

function jwtShape(token) {
  const raw = String(token || '');
  const idx = raw.indexOf('eyJ');
  const jwt = idx > 0 ? raw.slice(idx) : raw;
  const info = decodeToken(jwt) || {};
  return { token: raw, jwt, tenant: info.tenant || null, userId: info.userId || null, exp: info.exp || null };
}

function fromCookies() {
  let cookies = {};
  try { cookies = readCookies(); } catch { return null; }
  for (const [key, value] of Object.entries(cookies)) {
    if (!value || typeof value !== 'string') continue;
    const name = key.split('|').pop() || '';
    if (!/^(operationToken|operToken|opToken)$/i.test(name)) continue;
    if (!value.includes('eyJ')) continue;
    return { ...jwtShape(value), source: 'cookie', name };
  }
  return null;
}

export function resolveToken(root, { appOnly = false } = {}) {
  const reasons = [];
  try {
    const t = readAppToken();
    if (t && t.token) return { ...jwtShape(t.token), source: 'app' };
  } catch (err) {
    reasons.push('app: ' + err.message);
  }
  const cookie = fromCookies();
  if (cookie) return cookie;
  reasons.push('cookie: 没有 operationToken');
  if (!appOnly) {
    const acc = primaryAccount(root);
    if (acc && acc.token) return { ...jwtShape(acc.token), source: 'pool', accountId: acc.id, name: acc.name };
    reasons.push('pool: 号池为空');
  }
  const err = new Error('没有可用的登录凭证（' + reasons.join('；') + '）');
  err.reasons = reasons;
  throw err;
}
