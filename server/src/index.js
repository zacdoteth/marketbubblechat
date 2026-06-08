// server/src/index.js — http server (health) + WS fan-out.
import { createServer } from 'node:http';
import { PORT } from './config.js';
import { startFanout } from './fanout.js';

const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('CONFLUX backend live');
});
startFanout(server);
server.listen(PORT, () => console.log('CONFLUX backend on :' + PORT));
