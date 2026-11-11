import http from 'node:http';

const [path0 = '/superCowork/sapi/api/v1/chat/completions'] = process.argv.slice(2);
const body = JSON.stringify({ model: 'chat-flash', messages: [{ role: 'user', content: 'bridge probe' }], stream: false, max_tokens: 4 });
const req = http.request({ host: '127.0.0.1', port: 8787, path: path0, method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
  let out = '';
  res.on('data', (c) => (out += c));
  res.on('end', () => {
    console.log('status=' + res.statusCode + ' body=' + out.slice(0, 120).replace(/\s+/g, ' '));
  });
});
req.on('error', (e) => console.log('error: ' + e.message));
req.end(body);
