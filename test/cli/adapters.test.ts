import { describe, expect, it, vi } from 'vitest';

import {
  codexManagedEnvironment,
  codexManagedLaunchContext,
  keepCodexHostAlive,
} from '../../src/cli/commands/adapters.js';
import {
  codexHostStartArgs,
  hostControlEnvironment,
  HOST_START_PATH,
  requestHostStart,
  startHostControl,
  type HostControl,
  type HostStartRequest,
} from '../../src/cli/codex-host-control.js';
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

const AGENT = 'codex:aaaa1111';
const THREAD = '019fd3d0-75d2-7211-b743-d770c8c76fc6';

/** Post a raw body, so a request can carry what a well-formed client never sends. */
function post(
  location: string,
  capability: string | undefined,
  body: string,
  path: string = HOST_START_PATH,
): Promise<Response> {
  return fetch(`${location}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(capability === undefined ? {} : { 'x-concord-capability': capability }),
    },
    body,
  });
}

/**
 * A control whose "host" only records what it was asked to start. The log is
 * captured rather than written to stderr so a test can assert what a real
 * launch would have printed.
 */
async function withControl(
  run: (control: HostControl, started: HostStartRequest[], logs: string[]) => Promise<void>,
): Promise<void> {
  const started: HostStartRequest[] = [];
  const logs: string[] = [];
  const control = await startHostControl({
    startHost: (request) => {
      started.push(request);
    },
    log: (line) => {
      logs.push(line);
    },
  });
  try {
    await run(control, started, logs);
  } finally {
    await control.close();
  }
}

describe('Codex host-start control', () => {
  it('listens on loopback with a per-launch capability', async () => {
    const logs: string[] = [];
    const log = (line: string): void => {
      logs.push(line);
    };
    const first = await startHostControl({ startHost: () => undefined, log });
    const second = await startHostControl({ startHost: () => undefined, log });
    try {
      expect(first.location).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(second.location).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      // 32 random bytes in base64url, so no two launches share one.
      expect(first.capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(first.capability).not.toBe(second.capability);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('starts one host for a valid request', async () => {
    await withControl(async (control, started) => {
      const outcome = await requestHostStart(control, { agentId: AGENT, threadId: THREAD });

      expect(outcome).toEqual({ status: 'started' });
      expect(started).toEqual([{ agentId: AGENT, threadId: THREAD }]);
    });
  });

  it('is idempotent: a duplicate request starts nothing more', async () => {
    await withControl(async (control, started) => {
      await requestHostStart(control, { agentId: AGENT, threadId: THREAD });
      const again = await requestHostStart(control, { agentId: AGENT, threadId: THREAD });

      expect(again).toEqual({ status: 'already-running' });
      expect(started).toHaveLength(1);
    });
  });

  it('starts a second host for a different session', async () => {
    await withControl(async (control, started) => {
      await requestHostStart(control, { agentId: AGENT, threadId: THREAD });
      const other = await requestHostStart(control, {
        agentId: AGENT,
        threadId: '019fd3d0-9999-7211-b743-000000000000',
      });

      expect(other).toEqual({ status: 'started' });
      expect(started).toHaveLength(2);
    });
  });

  it('rejects an invalid capability and starts nothing', async () => {
    await withControl(async (control, started) => {
      const response = await post(
        control.location,
        'not-the-capability',
        JSON.stringify({ agentId: AGENT, threadId: THREAD }),
      );
      expect(response.status).toBe(401);

      const missing = await post(
        control.location,
        undefined,
        JSON.stringify({ agentId: AGENT, threadId: THREAD }),
      );
      expect(missing.status).toBe(401);

      const outcome = await requestHostStart(
        { location: control.location, capability: 'still-not-it' },
        { agentId: AGENT, threadId: THREAD },
      );
      expect(outcome.status).toBe('unavailable');
      expect(started).toHaveLength(0);
    });
  });

  it('rejects malformed ids', async () => {
    const bodies: unknown[] = [
      { agentId: 'codex:', threadId: THREAD },
      { agentId: 'codex:aaaa 1111', threadId: THREAD },
      { agentId: 'codex:../etc/passwd', threadId: THREAD },
      { agentId: 'codex:aaaa1111; rm -rf /', threadId: THREAD },
      { agentId: 'claude-code:aaaa1111', threadId: THREAD },
      { agentId: 'aaaa1111', threadId: THREAD },
      { agentId: AGENT, threadId: '' },
      { agentId: AGENT, threadId: '../../etc/passwd' },
      { agentId: AGENT, threadId: 'thread one' },
      { agentId: AGENT, threadId: 'thread\none' },
      {},
      { agentId: AGENT },
      { threadId: THREAD },
      'codex:aaaa1111',
    ];

    await withControl(async (control, started) => {
      for (const body of bodies) {
        const response = await post(control.location, control.capability, JSON.stringify(body));
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(started).toHaveLength(0);
    });
  });

  it('refuses any attempt to choose a command, path, or argument', async () => {
    const bodies: unknown[] = [
      { agentId: AGENT, threadId: THREAD, command: 'rm -rf /' },
      { agentId: AGENT, threadId: THREAD, path: 'C:\\Windows\\System32\\cmd.exe' },
      { agentId: AGENT, threadId: THREAD, exec: 'powershell' },
      { agentId: AGENT, threadId: THREAD, args: ['--evil'] },
      { agentId: AGENT, threadId: THREAD, env: { PATH: '/evil' } },
    ];

    await withControl(async (control, started) => {
      for (const body of bodies) {
        const response = await post(control.location, control.capability, JSON.stringify(body));
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
      expect(started).toHaveLength(0);

      // And the one command this control can start is built here, from ids.
      expect(codexHostStartArgs({ agentId: AGENT, threadId: THREAD })).toEqual([
        'adapters',
        'host-codex',
        '--agent',
        AGENT,
        '--thread',
        THREAD,
      ]);
    });
  });

  it('answers only one method and path, with no query channel', async () => {
    await withControl(async (control, started) => {
      const wrongPath = await post(
        control.location,
        control.capability,
        JSON.stringify({ agentId: AGENT, threadId: THREAD }),
        '/host/start/../../etc/passwd',
      );
      const query = await fetch(
        `${control.location}${HOST_START_PATH}?command=rm&agentId=${AGENT}&threadId=${THREAD}`,
        {
          method: 'POST',
          headers: { 'x-concord-capability': control.capability },
          body: JSON.stringify({ agentId: AGENT, threadId: THREAD }),
        },
      );
      const get = await fetch(`${control.location}${HOST_START_PATH}`, {
        headers: { 'x-concord-capability': control.capability },
      });

      expect(wrongPath.status).toBe(400);
      expect(query.status).toBe(400);
      expect(get.status).toBe(405);
      expect(started).toHaveLength(0);
    });
  });

  it('refuses an oversized body instead of buffering it', async () => {
    await withControl(async (control, started) => {
      // Valid JSON with trailing whitespace: only the size limit refuses it.
      const body = `${JSON.stringify({ agentId: AGENT, threadId: THREAD })}${' '.repeat(8192)}`;
      const response = await post(control.location, control.capability, body);

      expect(response.status).toBe(400);
      expect(started).toHaveLength(0);
    });
  });

  it('keeps the capability and request content out of the log', async () => {
    await withControl(async (control, started, logs) => {
      await post(control.location, 'wrong-capability', JSON.stringify({ agentId: AGENT }));
      await post(
        control.location,
        control.capability,
        JSON.stringify({ agentId: AGENT, threadId: THREAD, command: 'rm -rf /' }),
      );
      await post(control.location, control.capability, 'not json at all');

      const joined = logs.join('\n');
      expect(logs.length).toBeGreaterThan(0);
      expect(joined).not.toContain(control.capability);
      expect(joined).not.toContain('wrong-capability');
      expect(joined).not.toContain('rm -rf');
      expect(started).toHaveLength(0);
    });
  });

  it('hands the managed tree only the control location and capability', () => {
    const env = hostControlEnvironment(
      { location: 'http://127.0.0.1:43211', capability: 'cap-cap-cap' },
      { PATH: '/test/bin', USER_SETTING: 'preserved' },
    );

    expect(env).toEqual({
      PATH: '/test/bin',
      USER_SETTING: 'preserved',
      CONCORD_CODEX_HOST_CONTROL: 'http://127.0.0.1:43211',
      CONCORD_CODEX_HOST_CONTROL_TOKEN: 'cap-cap-cap',
    });
  });

  it('reports an unreachable launcher promptly instead of hanging', async () => {
    const outcome = await requestHostStart(
      { location: 'http://127.0.0.1:1', capability: 'whatever' },
      { agentId: AGENT, threadId: THREAD },
    );

    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') {
      expect(outcome.reason).toMatch(/launcher/iu);
    }
  });

  it('refuses a malformed request without a network call', async () => {
    await withControl(async (control, started) => {
      const outcome = await requestHostStart(control, {
        agentId: 'claude-code:aaaa1111',
        threadId: THREAD,
      });

      expect(outcome).toEqual({
        status: 'unavailable',
        reason: 'malformed agent or thread id',
      });
      expect(started).toHaveLength(0);
    });
  });

  it('stops starting hosts once the launcher closes its control', async () => {
    const started: HostStartRequest[] = [];
    const control = await startHostControl({
      startHost: (request) => {
        started.push(request);
      },
      log: () => undefined,
    });
    const location = control.location;
    const capability = control.capability;
    await control.close();

    await expect(
      requestHostStart({ location, capability }, { agentId: AGENT, threadId: THREAD }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'no reachable managed launcher' });
    expect(started).toHaveLength(0);
  });
});
