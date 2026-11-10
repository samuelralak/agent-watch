/** The command line, run as a real process. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CLI_ENTRY } from '../helpers/build.js';

/** Runs the command line and returns how it ended; `stopReading` closes its output first. */
async function run(args: readonly string[], stopReading = false) {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let errors = '';

  child.stdout.on('data', (chunk) => {
    output += chunk;
  });

  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });

  if (stopReading) {
    child.stdout.destroy();
  }

  const [code] = await once(child, 'exit');

  return { code, output, errors };
}

describe('the command line', () => {
  it('prints its help and ends well', async () => {
    const { code, output, errors } = await run(['--help']);

    expect(code).toBe(0);
    expect(output).toContain('agentwatch hooks install');
    expect(errors).toBe('');
  });

  it('ends quietly when whatever reads its output stops early', async () => {
    const { code, errors } = await run(['--help'], true);

    expect(code).toBe(0);
    expect(errors).toBe('');
  });

  it('says what is wrong with a command it does not know, and how to use it', async () => {
    const { code, errors } = await run(['--no-such-option']);

    expect(code).toBe(2);
    expect(errors).toContain('agentwatch:');
    expect(errors).toContain('Usage:');
  });
});
