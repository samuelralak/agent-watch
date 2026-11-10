/**
 * Signing with the user's fingerprint key, through the helper process. The helper here is a
 * stand-in that signs with an ordinary key: the real one needs a touch on the sensor.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { P256Verifier } from '../../src/adapters/crypto/p256-verifier.adapter.js';
import {
  EnclaveSigner,
  type EnclaveSignerOptions,
} from '../../src/adapters/enclave/enclave-signer.adapter.js';
import type { MessageFields } from '../../src/domain/message.js';
import { FAKE_HELPER } from '../helpers/lock.js';

const open: EnclaveSigner[] = [];

afterEach(() => {
  for (const signer of open.splice(0)) {
    signer.close();
  }
});

function setup(options: Partial<EnclaveSignerOptions> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyFile = join(mkdtempSync(join(tmpdir(), 'agentwatch-enclave-')), 'key');

  // The stand-in helper's "reference" to its key is the key itself, base64.
  writeFileSync(
    keyFile,
    Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  );

  const signer = new EnclaveSigner({
    helper: FAKE_HELPER,
    keyFile,
    reason: (fields) => `send your message to ${fields.session}`,
    ...options,
  });

  open.push(signer);

  const requests = (): { reason: string; approve: boolean }[] =>
    readFileSync(`${keyFile}.requests`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  return {
    signer,
    requests,
    verifier: new P256Verifier(publicKey.export({ type: 'spki', format: 'der' })),
  };
}

const message = (text: string): MessageFields => ({
  v: 2,
  session: 'aaaaaaaa-1111-2222-3333-444444444444',
  target: 'main',
  sender: 'user',
  aboutAgentId: null,
  aboutLabel: null,
  nonce: 'a'.repeat(32),
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_060_000,
  text,
});

describe('signing with the fingerprint key', () => {
  it("gives a signature the user's public key verifies, and no other text passes with it", async () => {
    const { signer, verifier } = setup();
    const signed = await signer.sign(message('ship it'));

    expect(signed).toMatchObject({ text: 'ship it', alg: 'ecdsa-p256-sha256' });
    expect(verifier.verify(signed)).toBe(true);
    expect(verifier.verify({ ...signed, text: 'ship something else' })).toBe(false);
  });

  it('asks once for a whole window: later messages go to the same helper without a new touch', async () => {
    const { signer, verifier, requests } = setup();
    const first = await signer.sign(message('one'));
    const second = await signer.sign(message('two'));

    expect(verifier.verify(first) && verifier.verify(second)).toBe(true);
    expect(requests().map((request) => request.approve)).toEqual([false, false]);
    expect(requests()[0]?.reason).toBe('send your message to aaaaaaaa-1111-2222-3333-444444444444');
  });

  it('asks for every message when each one needs approval', async () => {
    const { signer, requests } = setup({ approveEach: true });

    await signer.sign(message('one'));
    await signer.sign(message('two'));
    expect(requests().map((request) => request.approve)).toEqual([true, true]);
  });

  it('sends nothing when the fingerprint is not given', async () => {
    const { signer } = setup({ reason: () => 'REFUSE' });

    await expect(signer.sign(message('ship it'))).rejects.toThrow('Authentication canceled.');
  });

  it('fails the message instead of hanging when the helper stops, and recovers for the next', async () => {
    const calls = { count: 0 };
    const { signer, verifier } = setup({ reason: () => (calls.count++ === 0 ? 'CRASH' : 'again') });

    await expect(signer.sign(message('lost'))).rejects.toThrow('the signing helper stopped');
    expect(verifier.verify(await signer.sign(message('sent')))).toBe(true);
  });

  it('says so when the helper is not there to run', async () => {
    const { signer } = setup({ helper: '/nowhere/agentwatch-signer' });

    await expect(signer.sign(message('ship it'))).rejects.toThrow(/the signing helper/);
  });
});
