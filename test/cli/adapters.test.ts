import { describe, expect, it, vi } from 'vitest';

import {
  codexManagedEnvironment,
  codexManagedLaunchContext,
  keepCodexHostAlive,
} from '../../src/cli/commands/adapters.js';
import { spawnCommand } from '../../src/install/spawn-command.js';

describe('Codex managed launcher', () => {
  it('passes launcher arguments through to the child process', async () => {
    const child = spawnCommand(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1] ?? "")', 'space & percent%'],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(exitCode).toBe(0);
    expect(output).toBe('space & percent%');
  });

  it('passes the app-server URL to every managed child process', () => {
    const input = { PATH: '/test/bin', USER_SETTING: 'preserved' };

    expect(codexManagedEnvironment('ws://127.0.0.1:43210', input)).toEqual({
      PATH: '/test/bin',
      USER_SETTING: 'preserved',
      CONCORD_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:43210',
    });
    expect(input).not.toHaveProperty('CONCORD_CODEX_APP_SERVER_URL');
  });

  it('runs the app-server and TUI from the resolved repository root', () => {
    expect(
      codexManagedLaunchContext('/repos/talking-test', 'ws://127.0.0.1:43210', {
        PATH: '/test/bin',
      }),
    ).toEqual({
      cwd: '/repos/talking-test',
      env: {
        PATH: '/test/bin',
        CONCORD_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:43210',
      },
    });
  });
});

describe('Codex session host', () => {
  it('closes its relay and client when the app-server connection closes', async () => {
    let disconnect: (() => void) | undefined;
    const client = {
      onDisconnect: (listener: () => void) => {
        disconnect = listener;
      },
      close: vi.fn(),
    };
    const relay = { close: vi.fn(() => Promise.resolve()) };
    const hosting = keepCodexHostAlive(client, relay);

    expect(relay.close).not.toHaveBeenCalled();
    expect(disconnect).toBeTypeOf('function');
    disconnect?.();
    await hosting;

    expect(relay.close).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
