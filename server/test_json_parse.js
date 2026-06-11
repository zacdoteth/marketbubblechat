// Test to verify JSON.parse error handling
const chunks = [];
const raw = Buffer.concat([Buffer.from('{"broadcaster": {"user_id": 123}, "content":')])
  .toString('utf8');

console.log('Testing with truncated JSON:', JSON.stringify(raw));
try {
  const payload = JSON.parse(raw);
  console.log('Parsed successfully (unexpected):', payload);
} catch (e) {
  console.log('Caught error:', e.constructor.name, '-', e.message);
  console.log('Error type is SyntaxError:', e instanceof SyntaxError);
}
