import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { candidateExePaths } from './locate.mjs';

const require = createRequire(import.meta.url);
const DPAPI_SCRIPT = new URL('./dpapi.ps1', import.meta.url);

export function findTeleAgentPaths(env = process.env) {
  const home = os.homedir();
  const localDataDir = env.TELEAGENT_DATA_DIR || path.join(home, '.local', 'share', 'TeleAgent');
  const configDir = env.TELEAGENT_CONFIG_DIR || path.join(home, '.config', 'TeleAgent');
  return {
    home,
    localDataDir,
    configDir,
    localState: path.join(localDataDir, 'Local State'),
    debugFile: path.join(localDataDir, 'internal-debug.yaml'),
    ownerFile: path.join(localDataDir, 'current-owner.json'),
    installCandidates: candidateExePaths(env)
  };
}

export function readOwner(localDataDir) {
  const file = path.join(localDataDir, 'current-owner.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Unwraps the Chromium os_crypt key with Windows DPAPI (CurrentUser). */
export function readOsCryptKey(localStatePath) {
  if (process.platform !== 'win32') {
    throw new Error('os_crypt unwrap is only implemented for Windows DPAPI');
  }
  const scriptPath = path.join(os.tmpdir(), 'tpb-dpapi-' + process.pid + '.ps1');
  fs.writeFileSync(scriptPath, fs.readFileSync(DPAPI_SCRIPT, 'utf8'), 'utf8');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      env: { ...process.env, TPB_LOCAL_STATE: localStatePath },
      encoding: 'utf8',
      windowsHide: true
    });
    const hex = out.trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('unexpected DPAPI output: ' + JSON.stringify(out.slice(0, 80)));
    return Buffer.from(hex, 'hex');
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}

/** Chromium OSCrypt "v10" blobs: 3-byte tag + 12-byte nonce + ciphertext + 16-byte tag. */
export function decryptV10(key, b64) {
  const raw = Buffer.from(b64, 'base64');
  const prefix = raw.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10') throw new Error('unsupported blob prefix: ' + JSON.stringify(prefix));
  const nonce = raw.subarray(3, 15);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(15, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function jwtPayload(token) {
  try {
    const bare = token.includes(':') ? token.split(':').slice(1).join(':') : token;
    const part = bare.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Reads the TeleAgent app-auth token (safeStorage encrypted) for the current owner. */
export function readAppToken(paths = findTeleAgentPaths()) {
  const owner = readOwner(paths.localDataDir);
  if (!owner || !owner.ownerDir) throw new Error('current-owner.json missing or has no ownerDir; is TeleAgent signed in?');
  const tokenFile = path.join(paths.localDataDir, 'users', owner.ownerDir, 'app-auth', 'token.json');
  if (!fs.existsSync(tokenFile)) throw new Error('token.json not found at ' + tokenFile);
  const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  if (!raw.encrypted) throw new Error('token.json is not encrypted; unsupported layout');
  const key = readOsCryptKey(paths.localState);
  const token = decryptV10(key, raw.encryptedToken);
  let meta = null;
  if (raw.encryptedMeta) {
    try {
      meta = JSON.parse(decryptV10(key, raw.encryptedMeta));
    } catch {
      meta = null;
    }
  }
  return { token, meta, tokenFile, ownerDir: owner.ownerDir, payload: jwtPayload(token) };
}

function copyWithRetry(from, to, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.copyFileSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') break;
      // Chromium keeps the cookies DB open; brief retry usually wins.
      const until = Date.now() + 120;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  throw lastErr;
}

/** TeleAgent login cookies live in a partition DB; values are stored in plaintext. */
export function readCookies(paths = findTeleAgentPaths()) {
  const owner = readOwner(paths.localDataDir);
  const candidates = [];
  if (owner && owner.ownerDir) {
    candidates.push(path.join(paths.localDataDir, 'Partitions', 'owner%3A' + owner.ownerDir, 'Network', 'Cookies'));
  }
  candidates.push(path.join(paths.localDataDir, 'Network', 'Cookies'));
  let mod = null;
  try {
    mod = require('node:sqlite');
  } catch {
    mod = null;
  }
  const found = {};
  for (const db of candidates) {
    if (!fs.existsSync(db)) continue;
    if (!mod) {
      found.__error = 'node:sqlite unavailable (requires Node >= 22.5)';
      continue;
    }
    // Chromium keeps the DB open; a shared read-only handle usually works while the app runs,
    // so try in place first and only fall back to a byte copy.
    const readFrom = (file) => {
      const conn = new mod.DatabaseSync(file, { readOnly: true });
      try {
        for (const row of conn.prepare('SELECT host_key, name, value FROM cookies').all()) {
          found[row.host_key + '|' + row.name] = String(row.value == null ? '' : row.value);
        }
      } finally {
        conn.close();
      }
    };
    try {
      readFrom(db);
    } catch (err) {
      const tmp = db + '.tpb-copy';
      try {
        copyWithRetry(db, tmp);
        readFrom(tmp);
      } catch (inner) {
        found.__error = err.code === 'EBUSY' || inner.code === 'EBUSY'
          ? 'cookies DB is locked by the running TeleAgent app (close it, or ignore: token-based auth still works)'
          : inner.message;
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return found;
}
