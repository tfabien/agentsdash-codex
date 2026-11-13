// A stand-in for the core in the adapter tests: listens on the hub address, answers /health, collects events, serves /state.
// `node mini_hub.mjs` exits 1 when the port is taken, like the real hub.
import http from 'node:http';

const host = process.env.AGENTSDASH_HOST || process.env.CLAUDE_GADGET_HOST || '127.0.0.1:8765';
const [hostname, port] = host.split(':');
const sessions = new Map();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/health') return res.end(JSON.stringify({ ok: true, core: '9.9.9', protocol: 2, script: process.argv[1], startedAt: Date.now() }));
    if (req.method === 'GET' && req.url === '/state') return res.end(JSON.stringify({ sessions: [...sessions.values()] }));
    if (req.method === 'POST' && req.url === '/event') {
      try { const ev = JSON.parse(body); sessions.set(ev.session, { id: ev.session, project: ev.project }); } catch { /* ignore */ }
      return res.end('ok');
    }
    res.statusCode = 404;
    res.end('not found');
  });
});
server.on('error', () => process.exit(1));
server.listen(Number(port), hostname);
