import fs from 'node:fs';
import path from 'node:path';

function redactHeaders(headers, names) {
  const blocked = new Set((names || []).map((n) => n.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = blocked.has(k.toLowerCase()) ? '[redacted]' : v;
  }
  return out;
}

function truncate(str, max) {
  if (typeof str !== 'string') return str;
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n...[truncated ' + (str.length - max) + ' chars]';
}

export function parseSse(raw) {
  const text = [];
  const toolCalls = [];
  let usage = null;
  let finish = null;
  let events = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    events += 1;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.usage) usage = obj.usage;
    const choice = obj.choices && obj.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (typeof d.content === 'string') text.push(d.content);
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) toolCalls.push(tc?.function?.name ?? tc?.id ?? 'tool');
    }
  }
  return { text: text.join(''), toolCalls, usage, finish, events };
}

export function createCapture(config, logger) {
  const enabled = config?.enabled !== false;
  const dir = config?.dir || path.resolve(process.cwd(), 'captures');
  const maxBody = config?.maxBodyBytes ?? 4 * 1024 * 1024;
  const rotateBytes = config?.rotateBytes ?? 64 * 1024 * 1024;
  const redact = config?.redactHeaders || [];
  let file = path.join(dir, 'requests.jsonl');
  const seqFile = path.join(dir, '.seq');
  let size = 0;
  let seq = 0;

  if (enabled) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    // continue the id sequence across bridge restarts instead of re-issuing r000001
    try {
      const saved = Number(JSON.parse(fs.readFileSync(seqFile, 'utf8')).seq);
      if (Number.isFinite(saved) && saved > 0) seq = saved;
    } catch {
      /* no sidecar yet: fall back to a generous tail scan */
      try {
        const st = fs.statSync(file);
        const from = Math.max(0, st.size - 8 * 1024 * 1024);
        const fd = fs.openSync(file, 'r');
        let tail = '';
        try {
          const buf = Buffer.alloc(st.size - from);
          fs.readSync(fd, buf, 0, buf.length, from);
          tail = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
        for (const m of tail.matchAll(/"id":"r(\d{6,})"/g)) seq = Math.max(seq, Number(m[1]));
      } catch {
        /* fresh file */
      }
    }
  }

  function rotate() {
    if (size < rotateBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const next = path.join(dir, 'requests-' + stamp + '.jsonl');
    try {
      fs.renameSync(file, next);
    } catch {
      // ignore
    }
    size = 0;
    logger?.info?.('capture rotated to ' + next);
  }

  function write(entry) {
    if (!enabled) return;
    rotate();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(file, line, 'utf8');
    size += Buffer.byteLength(line);
  }

  return {
    enabled,
    file,
    begin(ctx) {
      seq += 1;
      if (enabled) {
        try {
          fs.writeFileSync(seqFile, JSON.stringify({ seq }), 'utf8');
        } catch {
          /* ignore */
        }
      }
      return {
        id: 'r' + String(seq).padStart(6, '0'),
        startedAt: new Date().toISOString(),
        ...ctx
      };
    },
    finish(entry) {
      const record = {
        id: entry.id,
        startedAt: entry.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: entry.durationMs,
        method: entry.method,
        path: entry.path,
        upstream: entry.upstream,
        upstreamUrl: entry.upstreamUrl,
        status: entry.status,
        model: entry.model,
        request: {
          headers: redactHeaders(entry.requestHeaders, redact),
          body: truncate(entry.requestBody, maxBody)
        },
        response: {
          headers: redactHeaders(entry.responseHeaders, redact),
          contentType: entry.responseContentType,
          sse: entry.sse ? parseSse(entry.responseBody) : null,
          body: entry.sse ? undefined : truncate(entry.responseBody, maxBody)
        },
        error: entry.error
      };
      write(record);
      return record;
    }
  };
}
