import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerHubCommand } from '../../src/cli/commands/hub-serve.js';
import { fetchMeta, incompatibility, REQUIRED_CAPABILITIES } from '../../src/cloud/client.js';
import type { HubServer } from '../../src/hub/server.js';

const KEY_A = 'hub-key-alpha-0123456789';

describe('concord hub serve', () => {
  let dir: string;
  let keyFile: string;
  let dbPath: string;
  let cleanup: (() => Promise<void>)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'concord-hub-cli-'));
    keyFile = join(dir, 'hub-keys.json');
    dbPath = join(dir, 'hub.db');
    cleanup = [];
    writeFileSync(
      keyFile,
      `${JSON.stringify({ machines: [{ key: KEY_A, name: 'alpha' }] }, null, 2)}\n`,
    );
  });

  afterEach(async () => {
    for (const stop of cleanup) await stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('launches the listener from its command and answers /v1/meta', async () => {
    const lines: string[] = [];
    let listening: (hub: HubServer) => void = () => undefined;
    const started = new Promise<HubServer>((resolve) => {
      listening = resolve;
    });
    let release: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });

    const program = new Command();
    program.exitOverride();
    registerHubCommand(program, {
      env: { HOME: dir },
      write: (line) => {
        lines.push(line);
      },
      fail: (message) => {
        throw new Error(message);
      },
      waitForStop: (hub) => {
        listening(hub);
        return stopped;
      },
    });

    // The command line a person types, through the same registration the CLI
    // entry wires up: not `--help`, but a listener on an ephemeral port.
    const command = program.parseAsync([
      'node',
      'concord',
      'hub',
      'serve',
      '--port',
      '0',
      '--db',
      dbPath,
      '--key-file',
      keyFile,
    ]);
    const hub = await started;
    cleanup.push(() => hub.close());

    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(lines.join('\n')).toContain(hub.url);
    // The paths the command line named are the ones it used.
    expect(existsSync(dbPath)).toBe(true);

    const meta = await fetchMeta(hub.url);
    expect(meta.apiVersion).toBe(1);
    expect(meta.capabilities).toEqual([...REQUIRED_CAPABILITIES]);
    expect(incompatibility(meta)).toBeNull();
    expect(readFileSync(keyFile, 'utf8')).toContain(KEY_A);

    release();
    await command;
    expect(lines.join('\n')).toContain('Concord hub stopped.');
  });

  it('fails fast from its command for a missing key file, and starts nothing', async () => {
    const messages: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerHubCommand(program, {
      env: { HOME: dir },
      write: (line) => {
        messages.push(line);
      },
      fail: (message) => {
        messages.push(message);
      },
      waitForStop: () => {
        throw new Error('the listener must not start');
      },
    });

    await program.parseAsync([
      'node',
      'concord',
      'hub',
      'serve',
      '--port',
      '0',
      '--db',
      dbPath,
      '--key-file',
      join(dir, 'absent-keys.json'),
    ]);
    const reported = messages.join('\n');
    expect(reported).toContain('absent-keys.json');
    expect(existsSync(join(dir, 'absent-keys.json'))).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });
});
