// In-memory test-only harness. Never used by the deployed Worker.
import { createServer } from 'node:http';
import worker from '../dist/server/index.js';
import { database } from './db.mjs';
const env = { DB: database() };
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const r = new Request('http://' + req.headers.host + req.url, { method: req.method, headers: { ...req.headers, 'CF-Connecting-IP': '192.0.2.1' }, ...(!['GET', 'HEAD'].includes(req.method) ? { body } : {}) });
    const out = await worker.fetch(r, env);
    res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) { res.writeHead(500); res.end('Test harness failed'); }
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => { server.close(); env.DB.close(); process.exit(0); });
