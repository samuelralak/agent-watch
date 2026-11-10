#!/usr/bin/env node
// Stands in for the Swift signing helper in tests. It speaks the same lines, but signs with an
// ordinary key instead of the Secure Enclave, and never asks for a fingerprint.
//
// A request whose reason contains "REFUSE" is answered with an error, as when the user cancels
// the fingerprint prompt; one containing "CRASH" ends the helper without an answer.
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [command, keyFile] = process.argv.slice(2);

if (command === 'create-key') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  process.stdout.write(
    `${JSON.stringify({
      // The real helper prints a reference to a key inside the Secure Enclave.
      key: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    })}\n`,
  );

  process.exit(0);
}

if (command !== 'sign' || !keyFile) {
  process.exit(1);
}

const key = createPrivateKey(Buffer.from(readFileSync(keyFile, 'utf8'), 'base64').toString());

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);

  // What was asked, for tests that check the wording and whether each message needs a touch.
  appendFileSync(`${keyFile}.requests`, `${JSON.stringify(request)}\n`);

  if (request.reason.includes('CRASH')) {
    process.exit(3);
  }

  const reply = request.reason.includes('REFUSE')
    ? { id: request.id, error: 'Authentication canceled.' }
    : {
        id: request.id,
        signature: sign('sha256', Buffer.from(request.data, 'base64'), key).toString('base64'),
      };

  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
