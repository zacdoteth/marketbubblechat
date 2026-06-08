import { verifyKickSignature } from './src/ingesters/kickWebhook.js';
import crypto from 'node:crypto';

// Generate a test RSA key pair
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

// Create a test signature
const data = 'test-message-id.12345.test-body';
const sign = crypto.createSign('RSA-SHA256');
sign.update(data);
sign.end();
const signature = sign.sign(privateKey, 'base64');

const pubKeyPem = publicKey.export({ format: 'pem', type: 'spki' });

// Test verification with correct signature
const result1 = verifyKickSignature({
  messageId: 'test-message-id',
  timestamp: '12345',
  body: 'test-body',
  signature: signature,
  publicKey: pubKeyPem,
});

console.log('Verification result (correct):', result1);

// Test verification with wrong signature
const result2 = verifyKickSignature({
  messageId: 'test-message-id',
  timestamp: '12345',
  body: 'WRONG-BODY',
  signature: signature,
  publicKey: pubKeyPem,
});

console.log('Verification result (wrong):', result2);
