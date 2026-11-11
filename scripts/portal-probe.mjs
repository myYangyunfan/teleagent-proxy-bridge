import { readAppToken } from '../src/teleagent/credentials.mjs';

const args = process.argv.slice(2);
const pretty = args.includes('--pretty');
const raw = args.filter((a) => a !== '--pretty');
const origin = raw[0] && raw[0].startsWith('http') ? raw.shift() : 'https://agent.teleai.com.cn';
const { token } = readAppToken();
for (const p of raw) {
  const url = origin + p;
  try {
    const res = await fetch(url, {
      method: process.env.PROBE_METHOD || 'GET',
      headers: { 'X-Token': token, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SuperAgent/1.0' },
      body: process.env.PROBE_BODY || undefined,
    });
    const body = await res.text();
    if (pretty) {
      try { console.log(res.status + ' ' + JSON.stringify(JSON.parse(body), null, 1).slice(0, 12000)); }
      catch { console.log(res.status + ' ' + body.slice(0, 2000)); }
    } else {
      console.log(p + ' -> ' + res.status + ' ' + body.slice(0, 700));
    }
  } catch (err) {
    console.log(p + ' -> ERR ' + err.message);
  }
}
