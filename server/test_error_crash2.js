import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const server = createServer();
const wss = new WebSocketServer({ server });

console.log('Testing if missing error handler crashes server...');

wss.on('connection', (ws) => {
  console.log('Client connected');
  console.log('Checking if error event has listeners:', ws.listenerCount('error'));
  
  // ONLY attach message handler - NO error handler
  ws.on('message', (msg) => {
    console.log('Message:', msg.toString());
  });
  
  // Simulate an internal error that would be emitted by the receiver
  setTimeout(() => {
    console.log('Emitting error event (simulating malformed frame error)...');
    console.log('Error listeners before emit:', ws.listenerCount('error'));
    
    try {
      ws.emit('error', new Error('Invalid WebSocket frame: malformed data'));
      console.log('After emit - process still running');
    } catch (e) {
      console.log('Caught error:', e.message);
    }
  }, 100);
});

server.listen(8889, () => {
  console.log('Server listening on 8889');
  
  setTimeout(() => {
    console.log('Process is still alive after 1 second');
    process.exit(0);
  }, 1000);
});
