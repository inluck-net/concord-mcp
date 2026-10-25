import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeUserConfig } from '../../src/config/user-config.js';
import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import {
  renderGeminiAfterAgent,
  renderGeminiAfterTool,
  renderHookPayload,
  renderMonitorLines,
  type DeliverableMessage,
} from '../../src/domain/pull-inbox.js';
import { CONCORD_SERVER_INSTRUCTIONS } from '../../src/install/instructions.js';
import {
  drainInbox,
  registeredLine,
  registerPullEndpoint,
  registerSession,
  watchInbox,
  workspaceStatus,
} from '../../src/cli/commands/inbox.js';
import {
  hostControlEnvironment,
  startHostControl,
  type HostStartRequest,
} from '../../src/cli/codex-host-control.js';
import { openContext } from '../../src/cli/context.js';
import { effectiveEndpointCapabilities, monitorCapabilityFor } from '../../src/domain/delivery.js';
import { agentIdForSession } from '../../src/domain/identity.js';
import { endpointPromptable, handleSendAgentMessage } from '../../src/tools/agent-messages.js';

function registerAgent(repos: Repositories, agentId: string): void {
  repos.agents.upsert({
    agentId,
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
}

function send(repos: Repositories, content: string, key: string): string {
  const result = handleSendAgentMessage(repos, {
    operation: 'prompt',
    agentId: 'alpha',
    toAgentId: 'beta',
    content,
    idempotencyKey: key,
  });
  return result.message.messageId;
}

describe('global hook instructions', () => {
  it('returns messaging-only text for a globally configured workspace', () => {
    const home = mkdtempSync(join(tmpdir(), 'concord-global-inbox-'));
    const repo = join(home, 'project');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const env = { HOME: home };
    writeUserConfig(env, { globalMode: true, globalInstructions: 'messaging' });

    const status = workspaceStatus(repo, env);

    expect(status['instructions']).toContain('To message an agent');
    expect(status['instructions']).not.toContain('Before editing');
  });
});

describe('pull-transport inbox', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    registerAgent(repos, 'alpha');
    registerAgent(repos, 'beta');
  });

  it('registers a promptable endpoint that no external process could push to', () => {
    registerPullEndpoint(repos, 'beta', 'claude-code');
    const endpoint = repos.agentEndpoints.getByAgent('beta');

    expect(endpoint?.transport).toBe('pull');
    expect(endpointPromptable(endpoint)).toBe(true);
  });

  it('queues a message instead of dispatching it, and only counts it delivered on drain', () => {
    registerPullEndpoint(repos, 'beta', 'claude-code');
    const messageId = send(repos, 'schema.ts is mine for the next hour', 'key-1');

    expect(repos.agentMessages.get(messageId)?.status).toBe('sent');

    const drained = drainInbox(repos, 'beta', 'claude-code');

    expect(drained.map((message) => message.messageId)).toEqual([messageId]);
    expect(repos.agentMessages.get(messageId)?.status).toBe('delivered');
  });

  it('drains each message exactly once', () => {
    registerPullEndpoint(repos, 'beta', 'claude-code');
    send(repos, 'first', 'key-1');
    send(repos, 'second', 'key-2');

    expect(drainInbox(repos, 'beta', 'claude-code')).toHaveLength(2);
    expect(drainInbox(repos, 'beta', 'claude-code')).toHaveLength(0);
  });

  it('queues a send for a recipient that never registered an endpoint', () => {
    const queued = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'anyone there?',
      idempotencyKey: 'key-1',
    });
    expect(queued.message.status).toBe('sent');
    expect(queued.outlook).toMatch(/no live session/i);
  });

  it('queues for a recipient whose session has gone stale, delivering when it returns', () => {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    registerPullEndpoint(repos, 'beta', 'claude-code', hourAgo);

    const messageId = send(repos, 'still there?', 'key-1');
    expect(repos.agentMessages.get(messageId)?.status).toBe('sent');
    expect(drainInbox(repos, 'beta', 'claude-code')).toHaveLength(1);
  });

  it('warns the sender when the recipient cannot be reached while idle', () => {
    registerPullEndpoint(repos, 'beta', 'codex');
    const outlook = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'ping',
      idempotencyKey: 'k',
    }).outlook;

    expect(outlook).toMatch(/next turn/i);
  });

  it('only advertises Cursor idle reachability while its monitor is running', () => {
    registerPullEndpoint(repos, 'beta', 'cursor');
    expect(effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'))).not.toContain(
      'idle',
    );

    drainInbox(repos, 'beta', 'cursor', monitorCapabilityFor('cursor'));
    const endpoint = repos.agentEndpoints.getByAgent('beta');
    expect(endpoint).toBeDefined();
    if (endpoint !== undefined) {
      repos.agentEndpoints.heartbeatReceiver(
        endpoint.endpointId,
        new Date(Date.now() + 10_000).toISOString(),
      );
    }

    expect(effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'))).toContain(
      'idle',
    );

    // A busy-turn hook may drain concurrently with the monitor. It refreshes
    // the endpoint without erasing a receiver lease it does not own.
    registerPullEndpoint(repos, 'beta', 'cursor');
    expect(effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'))).toContain(
      'idle',
    );

    if (endpoint !== undefined) repos.agentEndpoints.clearReceiver(endpoint.endpointId);
    expect(effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'))).not.toContain(
      'idle',
    );
  });

  it('stops advertising idle delivery when the receiver heartbeat expires', () => {
    registerPullEndpoint(repos, 'beta', 'gemini', Date.now(), monitorCapabilityFor('gemini'));
    const endpoint = repos.agentEndpoints.getByAgent('beta');
    expect(endpoint).toBeDefined();
    if (endpoint === undefined) return;

    repos.agentEndpoints.heartbeatReceiver(
      endpoint.endpointId,
      new Date(Date.now() + 10_000).toISOString(),
    );
    expect(effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'))).toContain(
      'idle',
    );

    repos.agentEndpoints.heartbeatReceiver(
      endpoint.endpointId,
      new Date(Date.now() - 1).toISOString(),
    );
    const capabilities = effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'));
    expect(capabilities).not.toContain('idle');
    expect(capabilities).not.toContain('inject');
  });

  it('removes signal listeners when a one-shot monitor receives a message', async () => {
    registerPullEndpoint(repos, 'beta', 'gemini');
    send(repos, 'wake up', 'monitor-exit');
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const delivered: string[] = [];

    await watchInbox(repos, 'beta', 'gemini', 250, true, (messages) => {
      delivered.push(...messages.map((message) => message.content));
    });

    expect(delivered).toEqual(['wake up']);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(effectiveEndpointCapabilities(repos.agentEndpoints.getByAgent('beta'))).not.toContain(
      'idle',
    );
  });

  it('keeps a live watcher running through transient SQLite contention', async () => {
    registerPullEndpoint(repos, 'beta', 'gemini');
    send(repos, 'wake up after contention', 'monitor-busy');
    const claim = repos.agentMessages.claimPendingForRecipient.bind(repos.agentMessages);
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' });
    const claimSpy = vi
      .spyOn(repos.agentMessages, 'claimPendingForRecipient')
      .mockImplementationOnce(() => {
        throw busy;
      })
      .mockImplementation(claim);
    const delivered: string[] = [];

    await watchInbox(repos, 'beta', 'gemini', 1, true, (messages) => {
      delivered.push(...messages.map((message) => message.content));
    });

    expect(delivered).toEqual(['wake up after contention']);
    expect(claimSpy).toHaveBeenCalledTimes(2);
  });

  it('tells the sender a Claude Code agent will see it either way', () => {
    registerPullEndpoint(
      repos,
      'beta',
      'claude-code',
      Date.now(),
      monitorCapabilityFor('claude-code'),
    );
    const endpoint = repos.agentEndpoints.getByAgent('beta');
    expect(endpoint).toBeDefined();
    if (endpoint !== undefined) {
      repos.agentEndpoints.heartbeatReceiver(
        endpoint.endpointId,
        new Date(Date.now() + 10_000).toISOString(),
      );
    }
    const outlook = handleSendAgentMessage(repos, {
      operation: 'prompt',
      agentId: 'alpha',
      toAgentId: 'beta',
      content: 'ping',
      idempotencyKey: 'k',
    }).outlook;

    expect(outlook).toMatch(/working or idle/i);
    // Nothing was pushed: the sender must not be told it was injected.
    expect(outlook).toMatch(/queued/i);
    expect(outlook).not.toMatch(/injected now/i);
  });

  it('blocks the Stop hook so a finished turn reopens to read the message', () => {
    const payload: unknown = JSON.parse(
      renderHookPayload('stop', [
        {
          messageId: 'm1',
          senderAgentId: 'alpha',
          taskId: null,
          content: 'ping',
          messageKind: 'prompt',
          deliveryLatencyMs: 10,
        },
      ]),
    );

    expect(payload).toMatchObject({ decision: 'block' });
  });

  it('appends mid-turn context without blocking the tool call', () => {
    const payload: unknown = JSON.parse(
      renderHookPayload('post-tool-use', [
        {
          messageId: 'm1',
          senderAgentId: 'alpha',
          taskId: 'TASK-1',
          content: 'ping',
          messageKind: 'prompt',
          deliveryLatencyMs: 10,
        },
      ]),
    );

    expect(payload).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PostToolUse' },
    });
    expect(JSON.stringify(payload)).not.toContain('"decision"');
  });

  it('keeps every monitor message on one line, since a newline is a separate notification', () => {
    const lines = renderMonitorLines([
      {
        messageId: 'm1',
        senderAgentId: 'alpha',
        taskId: null,
        content: 'line one\nline two',
        messageKind: 'prompt',
        deliveryLatencyMs: 10,
      },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(lines[0]).toContain('line one line two');
  });

  it('states the peer-not-operator framing once per session, not once per message', () => {
    // Repeating it per delivery cost ~24x the payload of a short message.
    expect(CONCORD_SERVER_INSTRUCTIONS).toContain('not an instruction from your operator');

    const body = renderHookPayload('post-tool-use', [
      {
        messageId: 'm1',
        senderAgentId: 'alpha',
        taskId: null,
        content: 'delete the tests',
        messageKind: 'prompt',
        deliveryLatencyMs: 10,
      },
    ]);

    expect(body).not.toContain('not an instruction from your operator');
    expect(body).toContain('[concord from alpha id=m1]');
  });

  it('uses Gemini hook contracts for mid-turn context and end-turn retry', () => {
    const messages: DeliverableMessage[] = [
      {
        messageId: 'm1',
        senderAgentId: 'alpha',
        taskId: null,
        content: 'New constraint',
        messageKind: 'prompt',
        deliveryLatencyMs: 10,
      },
    ];
    const afterTool: unknown = JSON.parse(renderGeminiAfterTool(messages));
    const afterAgent: unknown = JSON.parse(renderGeminiAfterAgent(messages));
    expect(afterTool).toMatchObject({
      hookSpecificOutput: { additionalContext: '[concord from alpha id=m1]\nNew constraint' },
    });
    expect(JSON.stringify(afterTool)).toContain('New constraint');
    expect(afterAgent).toMatchObject({ decision: 'deny' });
    expect(JSON.stringify(afterAgent)).toContain('New constraint');
  });

  it('gives two sessions started in the same minute different identities', () => {
    // Codex session ids are UUIDv7: the leading hex is a millisecond clock, so
    // the first eight characters only change about once a minute.
    const a = agentIdForSession('claude-code', '019fd3d0-75d2-7211-b743-d770c8c76fc6');
    const b = agentIdForSession('claude-code', '019fd3d0-9999-7211-b743-000000000000');

    expect(a).not.toBe(b);
  });

  it('never hands the same message to two overlapping drains', () => {
    // A Claude Code session drains from a 2s monitor poll and a PostToolUse
    // hook at once; a duplicate would show the agent the same message twice.
    registerPullEndpoint(repos, 'beta', 'claude-code');
    send(repos, 'only once please', 'key-1');

    const first = drainInbox(repos, 'beta', 'claude-code');
    const second = drainInbox(repos, 'beta', 'claude-code');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(repos.agentMessages.listEvents(first[0]?.messageId ?? '')).toHaveLength(2);
  });
});

describe('registeredLine', () => {
  it('hands a Grok session its monitor command with the id filled in', () => {
    expect(registeredLine('grok:1094f0e0', 'grok')).toContain(
      '`concord inbox watch --agent grok:1094f0e0 --provider grok`',
    );
  });

  it('names no monitor for a harness without a monitor command', () => {
    expect(registeredLine('claude-code:4f2a91c7', 'claude-code')).not.toContain('inbox watch');
  });
});

/** The Codex thread a SessionStart hook is handed, and the payload it comes in. */
const THREAD = '019fd3d0-75d2-7211-b743-d770c8c76fc6';
const SESSION_START = JSON.stringify({
  session_id: THREAD,
  cwd: '/repo',
  source: 'startup',
});

/** A workspace to register into, and an env no other test can pollute. */
function workspace(): { repo: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), 'concord-codex-register-'));
  const repo = join(home, 'project');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home };
  // `inbox register` is silent outside a workspace, so create one first.
  openContext(repo, env);
  return { repo, env };
}

/** A host that outlives the registration that asked for it, if all is well. */
function longLivedHost(): { child: ChildProcess; exited: () => boolean } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 50)'], { stdio: 'ignore' });
  let seen = false;
  child.once('exit', () => {
    seen = true;
  });
  return { child, exited: () => seen };
}

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('SessionStart host handoff', () => {
  it('finishes registration while the launcher-owned host is still alive', async () => {
    const { repo, env } = workspace();
    const started: HostStartRequest[] = [];
    const hosts: { child: ChildProcess; exited: () => boolean }[] = [];
    const detach = vi.fn();
    const control = await startHostControl({
      startHost: (request) => {
        started.push(request);
        hosts.push(longLivedHost());
      },
      log: () => undefined,
    });
    try {
      const out: string[] = [];
      const result = await registerSession({
        cwd: repo,
        env: hostControlEnvironment(control, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: (text) => {
          out.push(text);
        },
        report: (line) => {
          out.push(`${line}\n`);
        },
        detach,
      });

      // The registration is over. The host it asked for is not.
      await settle(100);

      const expected = agentIdForSession('codex', THREAD);
      expect(result.agentId).toBe(expected);
      expect(out.join('')).toContain(expected);
      expect(result.host).toEqual({ kind: 'launcher-owned', status: 'started' });
      expect(started).toEqual([{ agentId: expected, threadId: THREAD }]);
      expect(hosts[0]?.exited()).toBe(false);
      expect(hosts[0]?.child.exitCode).toBeNull();
      // The hook never spawned a host of its own: the launcher did.
      expect(detach).not.toHaveBeenCalled();
    } finally {
      await control.close();
      for (const host of hosts) host.child.kill();
    }
  });

  it('prints the same session agent id the host is started for', async () => {
    const { repo, env } = workspace();
    const started: HostStartRequest[] = [];
    const control = await startHostControl({
      startHost: (request) => {
        started.push(request);
      },
      log: () => undefined,
    });
    try {
      const out: string[] = [];
      await registerSession({
        cwd: repo,
        env: hostControlEnvironment(control, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: (text) => {
          out.push(text);
        },
        report: () => undefined,
      });

      const expected = agentIdForSession('codex', THREAD);
      const printed = out.join('');
      expect(printed).toContain(`"${expected}"`);
      expect(started.map((request) => request.agentId)).toEqual([expected]);
    } finally {
      await control.close();
    }
  });

  it('reports an idle-wake limitation on Windows rather than detaching a host', async () => {
    const { repo, env } = workspace();
    const detach = vi.fn();
    const reports: string[] = [];
    const startedAt = Date.now();

    const result = await registerSession({
      cwd: repo,
      env,
      agent: undefined,
      provider: 'codex',
      hookPayload: SESSION_START,
      platform: 'win32',
      write: () => undefined,
      report: (line) => {
        reports.push(line);
      },
      detach,
    });

    // Promptly: no child to wait on, and none started.
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(result.host).toEqual({
      kind: 'idle-wake-limited',
      reason: 'no managed launcher is reachable for this session',
    });
    expect(detach).not.toHaveBeenCalled();
    const said = reports.join('\n');
    expect(said).toMatch(/idle messages cannot wake/iu);
    expect(said).toMatch(/next turn/iu);
    expect(said).toMatch(/concord adapters codex/iu);
  });

  it('still prints the session agent id when idle wake is unavailable', async () => {
    const { repo, env } = workspace();
    const out: string[] = [];

    const result = await registerSession({
      cwd: repo,
      env,
      agent: undefined,
      provider: 'codex',
      hookPayload: SESSION_START,
      platform: 'win32',
      write: (text) => {
        out.push(text);
      },
      report: () => undefined,
    });

    expect(result.agentId).toBe(agentIdForSession('codex', THREAD));
    expect(out.join('')).toContain(agentIdForSession('codex', THREAD));
  });

  it('says the same for an invalid launcher capability, without waiting on it', async () => {
    const { repo, env } = workspace();
    const started: HostStartRequest[] = [];
    const control = await startHostControl({
      startHost: (request) => {
        started.push(request);
      },
      log: () => undefined,
    });
    try {
      const reports: string[] = [];
      const detach = vi.fn();
      const startedAt = Date.now();

      const result = await registerSession({
        cwd: repo,
        // A launcher that will refuse this capability: the hook must not wait
        // on a reply that is never coming.
        env: hostControlEnvironment({ location: control.location, capability: 'wrong' }, env),
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform: 'win32',
        write: () => undefined,
        report: (line) => {
          reports.push(line);
        },
        detach,
      });

      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(result.host?.kind).toBe('idle-wake-limited');
      expect(started).toHaveLength(0);
      expect(detach).not.toHaveBeenCalled();
      expect(reports.join('\n')).toMatch(/idle messages cannot wake/iu);
    } finally {
      await control.close();
    }
  });

  it('says the same for a launcher that is gone, without waiting on it', async () => {
    const { repo, env } = workspace();
    const reports: string[] = [];
    const detach = vi.fn();
    const startedAt = Date.now();

    const result = await registerSession({
      cwd: repo,
      // Loopback, so the control is accepted — but nothing is listening.
      env: hostControlEnvironment({ location: 'http://127.0.0.1:1', capability: 'gone' }, env),
      agent: undefined,
      provider: 'codex',
      hookPayload: SESSION_START,
      platform: 'win32',
      write: () => undefined,
      report: (line) => {
        reports.push(line);
      },
      detach,
    });

    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(result.host).toEqual({
      kind: 'idle-wake-limited',
      reason: 'no reachable managed launcher',
    });
    expect(detach).not.toHaveBeenCalled();
    expect(reports.join('\n')).toMatch(/idle messages cannot wake/iu);
  });

  it('keeps the detached host path on macOS and Linux', async () => {
    for (const platform of ['darwin', 'linux']) {
      const { repo, env } = workspace();
      const detached: HostStartRequest[] = [];
      const reports: string[] = [];

      const result = await registerSession({
        cwd: repo,
        env,
        agent: undefined,
        provider: 'codex',
        hookPayload: SESSION_START,
        platform,
        write: () => undefined,
        report: (line) => {
          reports.push(line);
        },
        detach: (request) => {
          detached.push(request);
        },
      });

      expect(result.host).toEqual({ kind: 'detached' });
      expect(detached).toEqual([{ agentId: agentIdForSession('codex', THREAD), threadId: THREAD }]);
      expect(reports).toEqual([]);
    }
  });

  it('asks for no host for a provider that is not Codex', async () => {
    const { repo, env } = workspace();
    const detach = vi.fn();
    const out: string[] = [];

    const result = await registerSession({
      cwd: repo,
      env,
      agent: undefined,
      provider: 'claude-code',
      hookPayload: SESSION_START,
      platform: 'win32',
      write: (text) => {
        out.push(text);
      },
      report: () => undefined,
      detach,
    });

    expect(result.host).toBeNull();
    expect(detach).not.toHaveBeenCalled();
    expect(result.agentId).toBe(agentIdForSession('claude-code', THREAD));
    expect(out.join('')).toContain(agentIdForSession('claude-code', THREAD));
  });
});
