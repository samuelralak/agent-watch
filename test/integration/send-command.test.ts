/**
 * `agentwatch send`: how an agent sends a message to another session. Whatever the policy, the
 * message arrives as an agent's, never as the user's.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HmacSigner } from '../../src/adapters/crypto/hmac-signer.adapter.js';
import { P256Verifier } from '../../src/adapters/crypto/p256-verifier.adapter.js';
import { FileInbox } from '../../src/adapters/fs/inbox.adapter.js';
import { DeliverMessagesService } from '../../src/application/deliver-messages.service.js';
import { runSendCommand } from '../../src/cli/send.command.js';
import { type Trust, UNLOCKED } from '../../src/domain/sending.policy.js';
import { fingerprintKey } from '../helpers/keys.js';
import { temporaryState } from '../helpers/state.js';

const API = 'aaaaaaaa-1111-2222-3333-444444444444';
const DOCS = 'bbbbbbbb-1111-2222-3333-444444444444';

function setup(trust: Trust = UNLOCKED, options: { fingerprintRefused?: boolean } = {}) {
  const paths = temporaryState();
  const inbox = new FileInbox(paths);
  const sharedKey = HmacSigner.load(paths.key);
  const fingerprint = fingerprintKey();
  const said: string[] = [];
  const prompts: string[] = [];
  let nonces = 0;

  const send = (session: string, text: string) =>
    runSendCommand(
      { command: 'send', session, text, aboutAgentId: null },
      {
        trust,
        inbox,
        sharedKey,
        write: (line) => said.push(line),
        newNonce: () => (++nonces).toString(16).padStart(32, '0'),
        sessionList: {
          list: async () => ({
            authoritative: true,
            sessions: [
              { sessionId: API, name: 'api' },
              { sessionId: DOCS, name: 'docs-site' },
            ],
          }),
        },
        approver: (reason) => {
          prompts.push(reason);

          return {
            close: () => {},
            sign: (fields) => {
              if (options.fingerprintRefused) {
                throw new Error('Authentication canceled.');
              }

              return fingerprint.sign(fields);
            },
          };
        },
      },
    );

  const received = (sessionId: string) =>
    new DeliverMessagesService({
      inbox,
      sharedKey,
      trust,
      fingerprintKey: new P256Verifier(fingerprint.publicKey),
      receipts: { delivered: () => {}, rejected: () => {} },
    }).deliver(sessionId, 'tool');

  const waiting = (sessionId: string): string[] => {
    try {
      return readdirSync(join(paths.inbox, sessionId)).filter((name) => name.endsWith('.msg'));
    } catch {
      return [];
    }
  };

  return { send, received, waiting, said, prompts };
}

describe("an agent's message, sent with agentwatch send", () => {
  it("reaches the session it names, marked as an agent's and not as the user's", async () => {
    const { send, received, said } = setup();

    expect(await send('api', 'the build is green')).toBe(0);
    expect(said[0]).toContain('Queued for api');

    const text = received(API);

    expect(text).toMatch(/^Message sent by another agent through agentwatch/);
    expect(text).toContain('the build is green');
    expect(received(DOCS)).toBeNull();
  });

  it('can name the session by the start of its id', async () => {
    const { send, waiting } = setup();

    expect(await send('bbbbbbbb', 'see the changelog')).toBe(0);
    expect(waiting(DOCS)).toHaveLength(1);
  });

  it('is not sent when no running session, or more than one, matches the name', async () => {
    const { send, waiting, said } = setup();

    expect(await send('billing', 'hello')).toBe(1);
    expect(await send('', 'hello')).toBe(1);
    expect(said[0]).toContain('no running session matches "billing"');
    expect(said[1]).toContain('matches several sessions');
    expect([...waiting(API), ...waiting(DOCS)]).toEqual([]);
  });

  it('is refused where agents may not send', async () => {
    const { send, waiting, said } = setup({ locked: true, agentSends: 'off' });

    expect(await send('api', 'the build is green')).toBe(1);
    expect(said[0]).toContain('agents may not send messages on this machine');
    expect(waiting(API)).toEqual([]);
  });

  it("asks for the user's fingerprint, showing the message, where each one needs approval", async () => {
    const { send, received, prompts } = setup({ locked: true, agentSends: 'approve' });

    expect(await send('api', 'the build is green')).toBe(0);
    expect(prompts).toEqual(['let an agent send this message to api: "the build is green"']);
    expect(received(API)).toMatch(/^Message sent by another agent/);
  });

  it('is not sent when the fingerprint is not given', async () => {
    const trust: Trust = { locked: true, agentSends: 'approve' };
    const { send, waiting, said } = setup(trust, { fingerprintRefused: true });

    expect(await send('api', 'the build is green')).toBe(1);
    expect(said[0]).toBe('Not sent: Authentication canceled.');
    expect(waiting(API)).toEqual([]);
  });

  it('goes without a fingerprint where agents may send freely, even with sending locked', async () => {
    const { send, received, prompts } = setup({ locked: true, agentSends: 'free' });

    expect(await send('api', 'the build is green')).toBe(0);
    expect(prompts).toEqual([]);
    expect(received(API)).toMatch(/^Message sent by another agent/);
  });
});
