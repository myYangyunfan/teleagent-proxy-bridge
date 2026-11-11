import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_CONFIG = {
  listen: { host: '127.0.0.1', port: 8787 },
  // Upstreams are tried in order when failover is enabled.
  upstreams: [
    {
      name: 'teleagent',
      // TeleAgent's own relay: newApiBaseUrl = <llmBaseUrl>/api/v1
      baseUrl: 'https://agent.teleai.com.cn/superCowork/sapi/api/v1',
      // Paths the bridge forwards upstream. The app calls <llmBaseUrl>/api/v1/*.
      match: ['/api/v1', '/superCowork'],
      // Extra headers injected on forward (e.g. a session token captured elsewhere).
      headers: {},
      timeoutMs: 300000
    }
  ],
  // Front door for third-party clients (Cherry Studio, Cline, Open WebUI...).
  openai: {
    enabled: true,
    prefix: '/v1',
    // When requireKey is true, /v1/* requires Authorization: Bearer <one of keys>.
    requireKey: true,
    keys: ['sk-tele-local'],
    upstream: 'teleagent',
    headers: {},
    // Advertised on GET /v1/models for third-party clients.
    models: ['chat-flash', 'chat-pro', 'chat-flagship', 'chat-lite', 'chat-nano']
  },
  // TeleAgent signs its requests against the URL it dials, so the hook must keep the upstream's
  // own path prefix: llmBaseUrl = http://127.0.0.1:8787/superCowork/sapi -> request path stays
  // /superCowork/sapi/api/v1/... and the signature validates. Dropping the prefix costs us a
  // 401 {"code":40104,"message":"invalid signature"} on every app request.
  hookPath: '/superCowork/sapi',
  // 每日签到（积分福利社 daily_login）。GET checkDayTask 找到未领取的 api 任务，再 GET 它的 jump_url。
  // 只要 X-Token，不需要 X-SA-* 签名；窗口内随机分钟执行，一天最多一次。
  signin: {
    enabled: true,
    origin: 'https://agent.teleai.com.cn',
    apiPrefix: '/superCowork/sapi',
    window: { start: '08:20', end: '11:40' },
    taskTypes: ['daily_login'],
    preClaimDelayMs: [2500, 9000],
    stateFile: '.signin-state.json',
    logFile: 'signin.log'
  },
  modelAliases: {},
  failover: { enabled: true, onStatusCode: [429, 500, 502, 503, 504] },
  capture: {
    enabled: true,
    dir: './captures',
    maxBodyBytes: 4 * 1024 * 1024,
    rotateBytes: 64 * 1024 * 1024,
    redactHeaders: ['authorization', 'x-token', 'cookie', 'x-sa-signature', 'x-api-key']
  },
  limits: { maxRequestBytes: 32 * 1024 * 1024 },
  admin: { enabled: true },
  logLevel: 'info'
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isObject(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (isObject(x) ? { ...x } : x));
    else out[k] = v;
  }
  return out;
}

export function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), 'bridge.config.json');
}

export function loadConfig(explicitPath) {
  const file = resolveConfigPath(explicitPath);
  let cfg = structuredClone(DEFAULT_CONFIG);
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error('bridge.config.json is not valid JSON: ' + err.message);
    }
    cfg = deepMerge(cfg, parsed);
  }
  // Environment overrides (handy for tests and for one-off runs).
  const env = process.env;
  if (env.TPB_PORT) cfg.listen.port = Number(env.TPB_PORT);
  if (env.TPB_HOST) cfg.listen.host = env.TPB_HOST;
  if (env.TPB_UPSTREAM) cfg.upstreams[0].baseUrl = env.TPB_UPSTREAM;
  if (env.TPB_CAPTURE_DIR) cfg.capture.dir = env.TPB_CAPTURE_DIR;
  if (env.TPB_CLIENT_KEYS) cfg.openai.keys = env.TPB_CLIENT_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.TPB_LOG_LEVEL) cfg.logLevel = env.TPB_LOG_LEVEL;

  cfg.capture.dir = path.resolve(process.cwd(), cfg.capture.dir);
  validateConfig(cfg);
  return { config: cfg, file, exists: fs.existsSync(file) };
}

export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.listen || typeof cfg.listen.port !== 'number') problems.push('listen.port must be a number');
  if (!Array.isArray(cfg.upstreams) || cfg.upstreams.length === 0) problems.push('at least one upstream is required');
  for (const [i, up] of (cfg.upstreams || []).entries()) {
    if (!up.name) problems.push('upstreams[' + i + '].name is required');
    try {
      const u = new URL(up.baseUrl);
      if (!/^https?:$/.test(u.protocol)) problems.push('upstreams[' + i + '].baseUrl must be http(s)');
    } catch {
      problems.push('upstreams[' + i + '].baseUrl is not a valid URL');
    }
    if (up.match) {
      for (const m of up.match) {
        if (!m.startsWith('/')) problems.push('upstreams[' + i + '].match entries must start with "/"');
      }
    }
  }
  if (cfg.openai?.enabled) {
    const names = new Set((cfg.upstreams || []).map((u) => u.name));
    if (cfg.openai.upstream && !names.has(cfg.openai.upstream)) {
      problems.push('openai.upstream must reference a configured upstream name');
    }
    if (cfg.openai.requireKey && (!cfg.openai.keys || cfg.openai.keys.length === 0)) {
      problems.push('openai.keys must not be empty when openai.requireKey is true');
    }
  }
  if (problems.length) {
    const err = new Error('invalid configuration:\n - ' + problems.join('\n - '));
    err.problems = problems;
    throw err;
  }
  return true;
}

export function defaultCapturePath(dir = './captures') {
  const base = path.resolve(process.cwd(), dir);
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, 'requests.jsonl');
}

export function teleAgentDebugFile(localDataDir) {
  const dir = localDataDir || path.join(os.homedir(), '.local', 'share', 'TeleAgent');
  return path.join(dir, 'internal-debug.yaml');
}
