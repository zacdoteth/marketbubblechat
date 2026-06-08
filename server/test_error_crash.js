import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const server = createServer();
const wss = new WebSocketServer({ server });

console.log('Testing if missing error handler crashes server...');

wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // ONLY attach message handler - NO error handler
  ws.on('message', (msg) => {
    console.log('Message:', msg.toString());
  });
  
  // Simulate an internal error that would be emitted by the receiver
  // (e.g., from malformed WebSocket frame parsing)
  setTimeout(() => {
    console.log('Emitting error event (simulating malformed frame error)...');
    ws.emit('error', new Error('Invalid WebSocket frame: malformed data'));
    console.log('This line will not be reached - process should have crashed');
  }, 100);
});

server.listen(8888, () => {
  console.log('Server listening on 8888');
  console.log('');
  console.log('Expected behavior:');
  console.log('  1. "Emitting error event" will be logged');
  console.log('  2. Process will crash with unhandled error');
  console.log('  3. "This line will not be reached" will NOT be logged');
  console.log('');
  
  setTimeout(() => {
    console.log('ERROR: Process did not crash! (something is catching the error)');
    process.exit(1);
  }, 1000);
});
