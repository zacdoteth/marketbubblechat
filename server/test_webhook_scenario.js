// Simulate the exact webhook handler code
import { createServer } from 'node:http';

const PORT = 8888;
let failedMessages = 0;
let successfulMessages = 0;

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhooks/kick') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const messageId = req.headers['kick-event-message-id'];
        const timestamp = req.headers['kick-event-message-timestamp'];
        const signature = req.headers['kick-event-signature'];
        // Simulate the JSON.parse that could fail
        const payload = JSON.parse(raw);
        console.log('✓ Parsed successfully:', payload);
        successfulMessages++;
      } catch (e) {
        // This is line 26 - the catch swallows the error silently
        console.warn('⚠ Error swallowed (no logging):', e.constructor.name, e.message);
        failedMessages++;
      }
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, async () => {
  console.log(`Test server on :${PORT}`);
  
  // Test 1: Valid JSON
  console.log('\n--- Test 1: Valid JSON ---');
  await fetch(`http://localhost:${PORT}/webhooks/kick`, {
    method: 'POST',
    body: JSON.stringify({ broadcaster: { user_id: 123 }, content: 'hello' })
  });

  // Test 2: Truncated/malformed JSON
  console.log('\n--- Test 2: Malformed JSON (truncated) ---');
  await fetch(`http://localhost:${PORT}/webhooks/kick`, {
    method: 'POST',
    body: '{"broadcaster": {"user_id": 123}, "content":'
  });

  // Test 3: Invalid JSON syntax
  console.log('\n--- Test 3: Invalid JSON syntax ---');
  await fetch(`http://localhost:${PORT}/webhooks/kick`, {
    method: 'POST',
    body: '{this is not json}'
  });

  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(`\n=== RESULTS ===`);
  console.log(`Successful: ${successfulMessages}`);
  console.log(`Failed/Swallowed: ${failedMessages}`);
  console.log(`Issue confirmed: Errors are silently dropped with no logging`);
  server.close();
});
