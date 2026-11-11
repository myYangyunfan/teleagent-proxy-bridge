import fs from 'node:fs';

const [file, ...needles] = process.argv.slice(2);
if (!file) { console.log('usage: node scripts/scan-strings.mjs <file> <needle...>'); process.exit(2); }
const size = fs.statSync(file).size;
console.log('file=' + file + ' size=' + size);
const buf = fs.readFileSync(file);
const enc = (s) => Buffer.from(s, 'utf8');
const dec = (b, from, len) => { try { return b.subarray(from, from + len).toString('utf8').replace(/[\u0000-\u001f]+/g, ' '); } catch { return ''; } };
for (const n of needles) {
  const needle = enc(n);
  let at = 0, count = 0, shown = 0;
  while ((at = buf.indexOf(needle, at)) !== -1) {
    count++;
    if (shown < 4) {
      const start = Math.max(0, at - 90);
      console.log('[' + n + '] @' + at + ' ... ' + dec(buf, start, 220));
      shown++;
    }
    at += needle.length;
  }
  console.log('[' + n + '] total=' + count);
}
