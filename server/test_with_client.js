import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { createServer } from 'node:http';

const server = createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Server: Client connected');
  console.log('Server: Error listeners:', ws.listenerCount('error'));
  
  ws.on('message', (msg) => console.log('Server: Message:', msg.toString()));
  
  // After client connects, wait and emit error
  setTimeout(() => {
    console.log('Server: About to emit error without handler...');
    ws.emit('error', new Error('Simulated malformed frame'));
    console.log('Server: After emit (should have crashed)');
  }, 200);
});

server.listen(8890, () => {
  console.log('Server listening on 8890');
  
  // Connect a client
  const client = new WebSocket('ws://localhost:8890');
  
  client.on('open', () => {
    console.log('Client: Connected');
  });
  
  client.on('error', (e) => {
    console.log('Client: Error event:', e.message);
  });
  
  client.on('close', () => {
    console.log('Client: Closed');
  });
  
  setTimeout(() => {
    console.log('Main: Process still alive');
    process.exit(0);
  }, 2000);
});
