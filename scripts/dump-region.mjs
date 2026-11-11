import fs from 'node:fs';

const [file, fromArg, lenArg, ...needles] = process.argv.slice(2);
const from = Number(fromArg), len = Number(lenArg);
const fd = fs.openSync(file, 'r');
const buf = Buffer.alloc(len);
const n = fs.readSync(fd, buf, 0, len, from);
fs.closeSync(fd);
const text = buf.subarray(0, n).toString('utf8');
console.log('read=' + n + ' from=' + from);
if (!needles.length) { console.log(text.slice(0, 4000)); process.exit(0); }
for (const needle of needles) {
  let i = 0, count = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    count++;
    if (count <= 6) console.log('[' + needle + '] @' + (from + i) + ' :: ' + text.slice(Math.max(0, i - 160), i + 200).replace(/\s+/g, ' '));
    i += needle.length;
  }
  console.log('[' + needle + '] total=' + count);
}
