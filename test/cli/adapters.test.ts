import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexManagedEnvironment,
  codexManagedLaunchContext,
  hostCodex,
  keepCodexHostAlive,
} from '../../src/cli/commands/adapters.js';
import { registerSession } from '../../src/cli/commands/inbox.js';
import {
  codexHostStartArgs,
  hostControlEnvironment,
  HOST_START_PATH,
  requestHostStart,
  startHostControl,
  type HostControl,
  type HostStartRequest,
} from '../../src/cli/codex-host-control.js';
import { openContext } from '../../src/cli/context.js';
import type { Repositories } from '../../src/db/index.js';
import { toReceipt } from '../../src/domain/receipts.js';
import { agentIdForSession } from '../../src/domain/identity.js';
import { CodexDaemonClient } from '../../src/relay/codex-client.js';
import { SocketAgentMessageDispatcher } from '../../src/relay/socket-dispatcher.js';
import { spawnCommand } from '../../src/install/spawn-command.js';
import {
  endpointPromptable,
  handleSendAgentMessage,
  handleSendAgentMessageWithDelivery,
} from '../../src/tools/agent-messages.js';

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

const SESSION_START = JSON.stringify({ session_id: THREAD, cwd: '/repo', source: 'startup' });
const SENDER = 'claude-code:alpha';

/**
 * A fake Codex app-server: the JSONL protocol `codex app-server proxy` speaks,
 * which is what `CodexDaemonClient` drives. It takes a `turn/start`, then
 * reports the pushed message as that turn's input and the turn as completed —
 * the two pieces of evidence a read receipt is made of.
 */
function fakeAppServerScript(): string {
  return `import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof frame.method !== 'string' || frame.id === undefined) return;
  const params = frame.params ?? {};
  if (frame.method !== 'turn/start') {
    process.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\\n');
    return;
  }
  const text = (params.input ?? []).map((part) => part.text ?? '').join('\\n');
  process.stdout.write(JSON.stringify({ id: frame.id, result: { turnId: 'turn-1' } }) + '\\n');
  process.stdout.write(
    JSON.stringify({
      method: 'item/started',
      params: {
        threadId: params.threadId,
        turnId: 'turn-1',
        item: {
          type: 'userMessage',
          clientId: params.clientUserMessageId ?? null,
          content: [{ type: 'text', text }],
        },
      },
    }) + '\\n',
  );
  process.stdout.write(
    JSON.stringify({
      method: 'turn/completed',
      params: { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } },
    }) + '\\n',
  );
});
`;
}

function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('Condition was not met in time.'));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

/**
 * Whether `agentId`'s host is up and taking messages. Registration leaves a
 * pull endpoint behind first, so promptable alone says nothing about the host.
 */
function hostIsUp(repos: Repositories, agentId: string): boolean {
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  return endpoint?.transport === 'local-ipc' && endpointPromptable(endpoint);
}

describe('launcher-owned Codex host', () => {
  it('takes an idle prompt and its reply receipt after SessionStart has returned', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-idle-'));
    const repo = join(home, 'project');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home };
    openContext(repo, env).repos.db.close();
    const bin = mkdtempSync(join(tmpdir(), 'concord-codex-bin-'));
    const fakeCodex = join(bin, 'fake-codex.mjs');
    writeFileSync(fakeCodex, fakeAppServerScript());

    const started: HostStartRequest[] = [];
    const clients: CodexDaemonClient[] = [];
    const failures: unknown[] = [];
    const hostings: Promise<void>[] = [];
    let closeTestDb: (() => void) | undefined;
    const control = await startHostControl({
      startHost: (request) => {
        started.push(request);
        const client = new CodexDaemonClient(process.execPath, [fakeCodex], '');
        clients.push(client);
        // What the launcher does: start the session host and own its lifetime.
        hostings.push(
          hostCodex(request.agentId, request.threadId, {
            cwd: repo,
            client,
            relayAddress: join(tmpdir(), `concord-host-${String(clients.length)}.sock`),
          }).catch((error: unknown) => {
            failures.push(error);
          }),
        );
      },
      log: () => undefined,
    });

    try {
      const codexAgent = agentIdForSession('codex', THREAD);
      const registration = await registerSession({
        cwd: repo,
        env: hostControlEnvironment(control, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: () => undefined,
        report: () => undefined,
      });

      // SessionStart is over before any host exists to talk to.
      expect(registration.agentId).toBe(codexAgent);
      expect(registration.host).toEqual({ kind: 'launcher-owned', status: 'started' });
      expect(started).toEqual([{ agentId: codexAgent, threadId: THREAD }]);

      const repos = openContext(repo, env).repos;
      closeTestDb = () => repos.db.close();
      repos.agents.upsert({
        agentId: SENDER,
        kind: 'claude-code',
        owner: null,
        model: null,
        pid: null,
        cwd: null,
        worktree: null,
        branch: null,
        summary: null,
        status: 'active',
      });
      await eventually(() => hostIsUp(repos, codexAgent));

      const sent = await handleSendAgentMessageWithDelivery(
        repos,
        {
          operation: 'prompt',
          agentId: SENDER,
          toAgentId: codexAgent,
          content: 'wake up and review the diff',
          idempotencyKey: 'idle-1',
        },
        new SocketAgentMessageDispatcher(),
      );

      expect(sent.delivery).toBe('delivered');
      expect(sent.immediateMode).toBe('inject');
      const messageId = sent.message.messageId;

      // The fake app-server recorded the turn; the host turned that into a read.
      await eventually(() => repos.agentMessages.get(messageId)?.status === 'read');
      const read = toReceipt(repos.agentMessages.get(messageId) ?? sent.message);
      expect(read.ticks).toBe('read');
      expect(read.read_at).not.toBeNull();

      // The Codex session answers, and the sender's receipt shows it.
      handleSendAgentMessage(repos, {
        operation: 'reply',
        agentId: codexAgent,
        toAgentId: SENDER,
        content: 'reviewed, no issues',
        replyToMessageId: messageId,
        idempotencyKey: 'reply-1',
      });
      const receipt = toReceipt(repos.agentMessages.get(messageId) ?? sent.message);
      expect(receipt.status).toBe('replied');
      expect(receipt.ticks).toBe('replied');
      expect(receipt.replied_at).not.toBeNull();
      expect(failures).toEqual([]);
    } finally {
      for (const client of clients) client.close();
      await Promise.all(hostings);
      await control.close();
      closeTestDb?.();
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('stops advertising delivery once the app-server it drives goes away', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-shutdown-'));
    const repo = join(home, 'project');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home };
    openContext(repo, env).repos.db.close();
    const bin = mkdtempSync(join(tmpdir(), 'concord-codex-bin-'));
    const fakeCodex = join(bin, 'fake-codex.mjs');
    writeFileSync(fakeCodex, fakeAppServerScript());

    const started: HostStartRequest[] = [];
    const clients: CodexDaemonClient[] = [];
    const failures: unknown[] = [];
    const hostings: Promise<void>[] = [];
    let closeTestDb: (() => void) | undefined;
    const control = await startHostControl({
      startHost: (request) => {
        started.push(request);
        const client = new CodexDaemonClient(process.execPath, [fakeCodex], '');
        clients.push(client);
        hostings.push(
          hostCodex(request.agentId, request.threadId, {
            cwd: repo,
            client,
            relayAddress: join(tmpdir(), `concord-host-${String(clients.length)}.sock`),
          }).catch((error: unknown) => {
            failures.push(error);
          }),
        );
      },
      log: () => undefined,
    });

    try {
      const codexAgent = agentIdForSession('codex', THREAD);
      await registerSession({
        cwd: repo,
        env: hostControlEnvironment(control, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: () => undefined,
        report: () => undefined,
      });

      const repos = openContext(repo, env).repos;
      closeTestDb = () => repos.db.close();
      repos.agents.upsert({
        agentId: SENDER,
        kind: 'claude-code',
        owner: null,
        model: null,
        pid: null,
        cwd: null,
        worktree: null,
        branch: null,
        summary: null,
        status: 'active',
      });
      await eventually(() => hostIsUp(repos, codexAgent));

      // The app-server — the host's reason to live — goes away.
      for (const client of clients) client.close();
      await Promise.all(hostings);
      await eventually(() => !endpointPromptable(repos.agentEndpoints.getByAgent(codexAgent)));

      // A message sent afterwards is queued for the agent's next turn, not
      // handed to a host that is no longer there to deliver it.
      const sent = handleSendAgentMessage(repos, {
        operation: 'prompt',
        agentId: SENDER,
        toAgentId: codexAgent,
        content: 'anyone there?',
        idempotencyKey: 'after-shutdown',
      });
      expect(sent.delivery).toBe('queued_pull');
      expect(failures).toEqual([]);
    } finally {
      for (const client of clients) client.close();
      await Promise.all(hostings);
      await control.close();
      closeTestDb?.();
      rmSync(home, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('starts one host for a duplicated SessionStart, not two', async () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-codex-dup-'));
    const repo = join(home, 'project');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: home };
    openContext(repo, env).repos.db.close();

    const started: HostStartRequest[] = [];
    const control = await startHostControl({
      // Records only: with no host running, neither registration can decide it
      // is already hosted and both must go through the launcher.
      startHost: (request) => {
        started.push(request);
      },
      log: () => undefined,
    });

    try {
      const first = await registerSession({
        cwd: repo,
        env: hostControlEnvironment(control, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: () => undefined,
        report: () => undefined,
      });
      const second = await registerSession({
        cwd: repo,
        env: hostControlEnvironment(control, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: () => undefined,
        report: () => undefined,
      });

      expect(started).toHaveLength(1);
      expect(first.host).toEqual({ kind: 'launcher-owned', status: 'started' });
      expect(second.host).toEqual({ kind: 'launcher-owned', status: 'already-running' });
    } finally {
      await control.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
