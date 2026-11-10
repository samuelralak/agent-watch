/** Who may send a message to a session, and what its signature has to prove. */
import { describe, expect, it } from 'vitest';
import { type AgentSends, refusal, type Trust, UNLOCKED } from '../../src/domain/sending.policy.js';

const locked = (agentSends: AgentSends): Trust => ({ locked: true, agentSends });

describe("the user's messages", () => {
  it('need the key agentwatch keeps in a file while sending is not locked', () => {
    expect(refusal('user', 'shared-key', UNLOCKED)).toBeNull();
    expect(refusal('user', 'none', UNLOCKED)).toBe('signature does not match');
  });

  it('need their fingerprint once sending is locked, whatever agents are allowed', () => {
    for (const agentSends of ['off', 'approve', 'free'] as const) {
      expect(refusal('user', 'fingerprint', locked(agentSends))).toBeNull();
      expect(refusal('user', 'shared-key', locked(agentSends))).toMatch(/need their fingerprint/);
      expect(refusal('user', 'none', locked(agentSends))).toBe('signature does not match');
    }
  });
});

describe("an agent's messages", () => {
  it('are refused when the policy is off, even with the fingerprint', () => {
    expect(refusal('agent', 'shared-key', locked('off'))).toBe('agents may not send messages here');

    expect(refusal('agent', 'fingerprint', locked('off'))).toBe(
      'agents may not send messages here',
    );
  });

  it('need the fingerprint, message by message, when the policy is approve', () => {
    expect(refusal('agent', 'fingerprint', locked('approve'))).toBeNull();
    expect(refusal('agent', 'shared-key', locked('approve'))).toMatch(/needs the user's approval/);
  });

  it('are delivered as they come when the policy is free, or sending is not locked', () => {
    expect(refusal('agent', 'shared-key', locked('free'))).toBeNull();
    expect(refusal('agent', 'shared-key', UNLOCKED)).toBeNull();
  });

  it('are never delivered unsigned', () => {
    expect(refusal('agent', 'none', locked('free'))).toBe('signature does not match');
    expect(refusal('agent', 'none', UNLOCKED)).toBe('signature does not match');
  });
});
