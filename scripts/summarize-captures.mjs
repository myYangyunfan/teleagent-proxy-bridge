import fs from 'node:fs';

const file = process.argv[2] || 'D:/workspace/tele-proxy-bridge/captures/requests.jsonl';
const full = process.argv.includes('--full');
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch { console.log('(unparsable line)'); continue; }
  const ua = String(j.request?.headers?.['user-agent'] || '');
  const sse = j.response?.sse ? ' sse[events=' + j.response.sse.events + ' text=' + JSON.stringify((j.response.sse.text || '').slice(0, 40)) + ']' : '';
  console.log([j.id, j.startedAt, j.method, j.path, '->', j.status, 'model=' + j.model, 'ua=' + ua.slice(0, 22)].join(' | ') + sse);
  if (full) {
    console.log('   resp: ' + String(j.response?.body || '').slice(0, 300).replace(/\s+/g, ' '));
    console.log('   req : ' + String(j.request?.body || '').slice(0, 300).replace(/\s+/g, ' '));
  }
}
