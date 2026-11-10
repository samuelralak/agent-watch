/**
 * Installing agentwatch's hooks into Claude Code's settings: nothing of the user's is lost,
 * uninstalling takes out exactly what was added, and a file that cannot be read is never touched.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookInstaller } from '../../src/adapters/claude/hook-installer.js';
import { SettingsUnreadableError } from '../../src/adapters/claude/settings-file.adapter.js';
import { HOOK_ENTRY } from '../helpers/build.js';
import { temporaryState } from '../helpers/state.js';

function setup(hookEntry = HOOK_ENTRY) {
  const paths = temporaryState();

  mkdirSync(dirname(paths.claudeSettings), { recursive: true });

  const installer = new HookInstaller({ paths, node: process.execPath, hookEntry });

  const write = (settings: object | string, indent: number | string = 2) =>
    writeFileSync(
      paths.claudeSettings,
      typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, indent)}\n`,
    );

  const read = () => JSON.parse(readFileSync(paths.claudeSettings, 'utf8'));
  const text = () => readFileSync(paths.claudeSettings, 'utf8');

  const commands = (event: string): string[] =>
    (read().hooks?.[event] ?? []).flatMap((group: { hooks?: { command: string }[] }) =>
      (group.hooks ?? []).map((hook) => hook.command),
    );

  const scripts = [paths.observeScript, paths.deliverScript, paths.waitScript];

  return { paths, installer, write, read, text, commands, scripts };
}

const USERS_OWN = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test:*)'] },
  hooks: {
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npx biome format' }] }],
    PreCompact: [{ hooks: [] }],
  },
};

describe('installing the hooks', () => {
  it('works on a machine with no settings file yet', () => {
    const { installer, read, scripts, paths } = setup();
    const result = installer.install();

    expect(result).toEqual({ settingsChanged: true, backup: null });
    expect(Object.keys(read().hooks)).toContain('SubagentStart');

    for (const script of scripts) {
      expect(statSync(script).mode & 0o111).not.toBe(0);
    }

    expect(installer.status()).toEqual({ installed: true, scriptsCurrent: true, problem: null });
    expect(statSync(paths.claudeSettings).mode & 0o077).toBe(0);
  });

  it("keeps everything of the user's, their own hooks first", () => {
    const { installer, write, read, commands, paths } = setup();

    write(USERS_OWN);
    installer.install();

    const settings = read();

    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual(USERS_OWN.permissions);
    expect(commands('PostToolUse')[0]).toBe('npx biome format');
    expect(commands('PostToolUse')).toContain(`/bin/sh '${paths.deliverScript}' tool`);

    expect(commands('Stop')).toEqual([
      `/bin/sh '${paths.observeScript}'`,
      `/bin/sh '${paths.deliverScript}' turn-end`,
      `/bin/sh '${paths.waitScript}'`,
    ]);

    expect(settings.hooks.PreCompact[0]).toEqual({ hooks: [] }); // a group the user left empty
  });

  it('changes nothing when run a second time, wherever the hooks sit in the file', () => {
    const { installer, write, text } = setup();

    // An event the user had left empty is filled in place, not moved to the end.
    write({ hooks: { Notification: [], ...USERS_OWN.hooks }, model: 'opus' });
    installer.install();

    const once = text();

    expect(installer.install()).toEqual({ settingsChanged: false, backup: null });
    expect(text()).toBe(once);
  });

  it('replaces an older registration instead of adding a second one', () => {
    const { installer, write, commands, paths } = setup();

    // How an earlier version registered delivery: with no word for the moment.
    write({
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: `/bin/sh '${paths.observeScript}'`, timeout: 10 },
              { type: 'command', command: `/bin/sh '${paths.deliverScript}'`, timeout: 15 },
            ],
          },
        ],
      },
    });

    expect(installer.status().installed).toBe(true);
    installer.install();

    expect(commands('PostToolUse')).toEqual([
      `/bin/sh '${paths.observeScript}'`,
      `/bin/sh '${paths.deliverScript}' tool`,
    ]);
  });

  it('keeps the indentation and the permissions of the file, and a backup of what was there', () => {
    const { installer, write, text, paths } = setup();

    write(USERS_OWN, '\t');
    chmodSync(paths.claudeSettings, 0o640);

    const before = text();
    const result = installer.install();

    expect(text()).toMatch(/^\{\n\t"model"/);
    expect(statSync(paths.claudeSettings).mode & 0o777).toBe(0o640);
    expect(result.backup).not.toBeNull();
    expect(readFileSync(result.backup ?? '', 'utf8')).toBe(before);
    expect(statSync(result.backup ?? '').mode & 0o077).toBe(0); // a backup is private
  });

  it('writes through a symlinked settings file instead of replacing the link', () => {
    const { installer, paths, read } = setup();
    const real = join(dirname(paths.claudeSettings), 'dotfiles-settings.json');

    writeFileSync(real, `${JSON.stringify(USERS_OWN, null, 2)}\n`);
    symlinkSync(real, paths.claudeSettings);
    installer.install();

    expect(lstatSync(paths.claudeSettings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.SubagentStart).toBeDefined();
    expect(read().model).toBe('opus');
  });

  it('keeps only the three most recent backups', async () => {
    const { installer, paths } = setup();

    for (let round = 0; round < 5; round++) {
      installer.install();
      installer.uninstall();
      await new Promise((resolve) => setTimeout(resolve, 5)); // backups are named by the time
    }

    const backups = readdirSync(dirname(paths.claudeSettings)).filter((name) =>
      name.includes('.agentwatch-backup-'),
    );

    expect(backups).toHaveLength(3);
  });

  it('never touches a settings file it cannot read as settings', () => {
    for (const broken of ['{ "model": "opus", ', '[1, 2, 3]\n', '"just a string"\n']) {
      const { installer, write, text, scripts } = setup();

      write(broken);

      expect(() => installer.install()).toThrow(SettingsUnreadableError);
      expect(() => installer.uninstall()).toThrow(SettingsUnreadableError);
      expect(text()).toBe(broken);

      for (const script of scripts) {
        expect(existsSync(script)).toBe(false);
      }

      expect(installer.status().installed).toBe(false);
    }
  });
});

describe('uninstalling the hooks', () => {
  it('leaves the settings exactly as they were before installing', () => {
    const { installer, write, read, scripts } = setup();

    write(USERS_OWN);
    installer.install();

    const result = installer.uninstall();

    expect(result.settingsChanged).toBe(true);
    expect(read()).toEqual(USERS_OWN);

    for (const script of scripts) {
      expect(existsSync(script)).toBe(false);
    }
  });

  it('leaves no empty hooks key behind when the hooks were all its own', () => {
    const { installer, write, read } = setup();

    write({ model: 'opus' });
    installer.install();
    installer.uninstall();
    expect(read()).toEqual({ model: 'opus' });
  });

  it("removes only its own command from a group it shares with the user's", () => {
    const { installer, write, read, paths } = setup();

    write({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'say done' },
              { type: 'command', command: `/bin/sh '${paths.observeScript}'` },
            ],
          },
        ],
      },
    });

    installer.uninstall();

    expect(read()).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    });
  });

  it('does nothing to settings that never had the hooks', () => {
    const { installer, write, text } = setup();

    write(USERS_OWN);

    const before = text();

    expect(installer.uninstall()).toEqual({ settingsChanged: false, backup: null });
    expect(text()).toBe(before);
  });
});

describe('the hook scripts', () => {
  it('are rewritten by an update when they are out of date, and the settings are not', () => {
    const { installer, text, paths } = setup();

    installer.install();

    const settings = text();

    writeFileSync(paths.deliverScript, '#!/bin/sh\n# from an older version\n');

    expect(installer.status().scriptsCurrent).toBe(false);
    expect(installer.refreshScripts()).toBe(true);
    expect(installer.status().scriptsCurrent).toBe(true);
    expect(installer.refreshScripts()).toBe(false);
    expect(text()).toBe(settings);
  });

  it('are reported as unusable when the build they run is missing', () => {
    const { installer } = setup('/nowhere/dist/hook/main.js');

    expect(installer.status().problem).toContain('/nowhere/dist/hook/main.js is missing');
  });
});
