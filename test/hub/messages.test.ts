import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runHubServe } from '../../src/cli/commands/hub-serve.js';
import {
  connectPullEndpoint,
  drainCloud,
  listCloudAgents,
  registerCloudAgent,
  releaseReceiver,
  renewReceiver,
  type CloudAgentRef,
  type CloudRuntime,
} from '../../src/cloud/runtime.js';
import type { HubServer } from '../../src/hub/server.js';

const KEY_A = 'hub-key-alpha-0123456789';
const KEY_B = 'hub-key-bravo-0123456789';
const KEY_C = 'hub-key-charlie-0123456789';
const WRONG_KEY = 'hub-key-xray-0123456789';

const agentView = z.object({
  id: z.string(),
  agentKey: z.string(),
  kind: z.string(),
  summary: z.string().nullable(),
  status: z.string(),
  lastSeenAt: z.string(),
});
const registeredAgent = z.object({ agent: agentView });

const receiptBody = z.object({
  receipt: z.object({
    message_id: z.string(),
    status: z.enum(['sent', 'delivered', 'read', 'replied', 'failed']),
    ticks: z.string(),
    sent_at: z.string(),
    delivered_at: z.string().nullable(),
    replied_at: z.string().nullable(),
    error_code: z.string().nullable(),
    expires_at: z.string().nullable(),
  }),
});

const sentBody = z.object({
  message: z.object({
    id: z.string(),
    senderAgentKey: z.string().nullable(),
    taskKey: z.string().nullable(),
    replyToMessageId: z.string().nullable(),
    content: z.string(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
  }),
  receipt: receiptBody.shape.receipt,
  idempotentReplay: z.boolean(),
  delivery: z.string(),
  outlook: z.string(),
});

type SentBody = z.infer<typeof sentBody>;
type Receipt = z.infer<typeof receiptBody>['receipt'];

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

describe('hub agents and messages', () => {
  let dir: string;
  let keyFile: string;
  let dbPath: string;
  let logs: string[];
  let running: HubServer[];
  let hub: HubServer;

  const log = (line: string): void => {
    logs.push(line);
  };

  async function serve(): Promise<HubServer> {
    const started = await runHubServe({ port: 0, db: dbPath, keyFile }, { env: {}, log });
    running.push(started);
    hub = started;
    return started;
  }

  /** A client runtime against the hub, as this machine and key. */
  function runtimeFor(key: string, machineKey: string): CloudRuntime {
    return {
      apiUrl: hub.url,
      bearer: () => Promise.resolve(key),
      machineKey,
      projectKey: 'github.com/acme/hub-test',
      repoRoot: dir,
      checkoutRoot: dir,
      fetch,
    };
  }

  async function post(path: string, key: string, body: object): Promise<Response> {
    return fetch(`${hub.url}${path}`, {
      method: 'POST',
      headers: auth(key),
      body: JSON.stringify(body),
    });
  }

  async function put(path: string, key: string, body: object): Promise<Response> {
    return fetch(`${hub.url}${path}`, {
      method: 'PUT',
      headers: auth(key),
      body: JSON.stringify(body),
    });
  }

  async function get(path: string, key: string): Promise<Response> {
    return fetch(`${hub.url}${path}`, { headers: auth(key) });
  }

  /** Registers a machine and one agent session on it, as the client does. */
  async function host(
    key: string,
    machineKey: string,
    agentKey: string,
  ): Promise<{ key: string; runtime: CloudRuntime; agent: CloudAgentRef }> {
    const runtime = runtimeFor(key, machineKey);
    const agent = await registerCloudAgent(runtime, { agentKey, kind: 'claude-code' });
    return { key, runtime, agent };
  }

  async function send(key: string, body: object): Promise<Response> {
    return post('/v1/messages', key, body);
  }

  async function sendPrompt(
    from: { key: string; agent: CloudAgentRef },
    to: CloudAgentRef,
    idempotencyKey: string,
    content: string,
  ): Promise<SentBody> {
    const response = await send(from.key, {
      operation: 'prompt',
      agentId: from.agent.agentId,
      toAgentId: to.agentId,
      content,
      idempotencyKey,
    });
    expect(response.status).toBe(200);
    return sentBody.parse(await response.json());
  }

  async function receiptOf(key: string, messageId: string): Promise<Receipt> {
    const response = await get(`/v1/messages/${messageId}`, key);
    expect(response.status).toBe(200);
    return receiptBody.parse(await response.json()).receipt;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'concord-hub-msg-'));
    keyFile = join(dir, 'hub-keys.json');
    dbPath = join(dir, 'hub.db');
    logs = [];
    running = [];
    writeFileSync(
      keyFile,
      `${JSON.stringify(
        {
          machines: [
            { key: KEY_A, name: 'alpha-label' },
            { key: KEY_B, name: 'bravo-label' },
            { key: KEY_C, name: 'charlie-label' },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await serve();
  });

  afterEach(async () => {
    for (const server of running) await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers an agent per machine and lists every one as presence', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');
    expect(alpha.agent.agentId).toBe('claude-code:alpha');

    const roster = await listCloudAgents(alpha.runtime);
    expect(roster.map((agent) => agent.agentKey).sort()).toEqual([
      'claude-code:alpha',
      'claude-code:bravo',
    ]);
    expect(roster.find((agent) => agent.agentKey === 'claude-code:bravo')).toMatchObject({
      kind: 'claude-code',
      status: 'active',
    });

    // A machine sees its own agent by id, and another machine's agent is refused.
    const mine = await get(`/v1/agents/${alpha.agent.agentId}`, KEY_A);
    expect(mine.status).toBe(200);
    expect(registeredAgent.parse(await mine.json()).agent.id).toBe('claude-code:alpha');
    const theirs = await get(`/v1/agents/${bravo.agent.agentId}`, KEY_A);
    expect(theirs.status).toBe(403);
  });

  it('refuses every operation on an agent that belongs to another machine', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');

    // A key cannot register an agent on another machine's registration...
    const onAnother = await post('/v1/agents', KEY_B, {
      agentKey: 'claude-code:intruder',
      kind: 'claude-code',
      machineId: alpha.agent.machineId,
      pid: 1,
    });
    expect(onAnother.status).toBe(403);
    // ...nor take over an agent another machine already registered.
    const takeover = await post('/v1/agents', KEY_B, {
      agentKey: 'claude-code:alpha',
      kind: 'claude-code',
      machineId: bravo.agent.machineId,
      pid: 1,
    });
    expect(takeover.status).toBe(403);

    const drain = await post('/v1/messages/drain', KEY_B, {
      agentId: alpha.agent.agentId,
      drainKey: 'not-ours',
      waitSeconds: 0,
    });
    expect(drain.status).toBe(403);

    const endpoint = await put(`/v1/agents/${alpha.agent.agentId}/endpoint`, KEY_B, {
      provider: 'claude-code',
      transport: 'pull',
      capabilities: ['pull'],
      address: 'pull:claude-code:alpha',
      credentialHash: 'none',
    });
    expect(endpoint.status).toBe(403);

    const failed = await post(`/v1/messages/m-nope/failure`, KEY_B, {
      agentId: alpha.agent.agentId,
      errorCode: 'target_not_promptable',
      errorDetail: 'not mine',
    });
    expect(failed.status).toBe(403);

    // A key that has registered no machine has no agents at all.
    const unregistered = await post('/v1/agents', KEY_C, {
      agentKey: 'claude-code:charlie',
      kind: 'claude-code',
      machineId: 'whatever',
      pid: 1,
    });
    expect(unregistered.status).toBe(403);

    // And an unauthenticated caller gets nowhere near any of it.
    const anonymous = await fetch(`${hub.url}/v1/messages/drain`, {
      method: 'POST',
      headers: auth(WRONG_KEY),
      body: JSON.stringify({ agentId: alpha.agent.agentId, drainKey: 'x', waitSeconds: 0 }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('delivers a prompt once, however often its key is repeated', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');

    const sent = await sendPrompt(alpha, bravo.agent, 'send-1', 'hello from alpha');
    expect(sent.idempotentReplay).toBe(false);
    expect(sent.receipt.status).toBe('sent');
    expect(sent.receipt.ticks).toBe('✓');
    expect(sent.message.senderAgentKey).toBe('claude-code:alpha');

    const repeated = await sendPrompt(alpha, bravo.agent, 'send-1', 'hello from alpha');
    expect(repeated.idempotentReplay).toBe(true);
    expect(repeated.message.id).toBe(sent.message.id);

    // The same key under a different message is refused, and changes nothing.
    const other = await send(KEY_A, {
      operation: 'prompt',
      agentId: alpha.agent.agentId,
      toAgentId: bravo.agent.agentId,
      content: 'a different message',
      idempotencyKey: 'send-1',
    });
    expect(other.status).toBe(403);

    const batch = await drainCloud(bravo.runtime, bravo.agent, 'drain-1');
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      id: sent.message.id,
      senderAgentKey: 'claude-code:alpha',
      content: 'hello from alpha',
    });

    // A drain key replays its batch; a fresh key finds nothing left.
    const replay = await drainCloud(bravo.runtime, bravo.agent, 'drain-1');
    expect(replay.map((message) => message.id)).toEqual([sent.message.id]);
    expect(await drainCloud(bravo.runtime, bravo.agent, 'drain-2')).toEqual([]);
  });

  it('waits for a prompt a drain would otherwise miss', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');

    const waiting = drainCloud(bravo.runtime, bravo.agent, 'drain-wait', 3);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await sendPrompt(alpha, bravo.agent, 'send-wait', 'arriving shortly');
    const arrived = await waiting;
    expect(arrived.map((message) => message.content)).toEqual(['arriving shortly']);
  });

  it('replies and reports the original receipt as replied', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');
    const sent = await sendPrompt(alpha, bravo.agent, 'send-2', 'are you there?');
    expect((await receiptOf(KEY_A, sent.message.id)).status).toBe('sent');

    await drainCloud(bravo.runtime, bravo.agent, 'drain-3');
    expect((await receiptOf(KEY_A, sent.message.id)).status).toBe('delivered');

    const reply = await send(KEY_B, {
      operation: 'reply',
      agentId: bravo.agent.agentId,
      replyToMessageId: sent.message.id,
      content: 'yes',
      idempotencyKey: 'reply-1',
    });
    expect(reply.status).toBe(200);
    const answered = sentBody.parse(await reply.json());
    expect(answered.message.replyToMessageId).toBe(sent.message.id);

    const original = await receiptOf(KEY_A, sent.message.id);
    expect(original.status).toBe('replied');
    expect(original.ticks).toBe('replied');
    expect(original.replied_at).not.toBeNull();

    // A third machine holds no part of that message, and is told no more than
    // that it is not there.
    await host(KEY_C, 'machine-charlie', 'claude-code:charlie');
    const snooped = await get(`/v1/messages/${sent.message.id}`, KEY_C);
    expect(snooped.status).toBe(404);
  });

  it('keeps agents, messages and drain batches across a restart', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');
    const sent = await sendPrompt(alpha, bravo.agent, 'send-3', 'still here');
    await drainCloud(bravo.runtime, bravo.agent, 'drain-4');
    await hub.close();

    await serve();
    const alphaAgain = runtimeFor(KEY_A, 'machine-alpha');
    const bravoAgain = runtimeFor(KEY_B, 'machine-bravo');
    const bravoRef = { agentId: bravo.agent.agentId, machineId: bravo.agent.machineId };

    // Registration state, message state, and the batch a lost drain already
    // delivered all live in the SQLite file the command was given.
    const registeredAgain = await registerCloudAgent(alphaAgain, {
      agentKey: 'claude-code:alpha',
      kind: 'claude-code',
    });
    expect(registeredAgain).toEqual(alpha.agent);
    const roster = await listCloudAgents(alphaAgain);
    expect(roster.map((agent) => agent.agentKey).sort()).toEqual([
      'claude-code:alpha',
      'claude-code:bravo',
    ]);
    expect((await receiptOf(KEY_A, sent.message.id)).status).toBe('delivered');

    const replay = await drainCloud(bravoAgain, bravoRef, 'drain-4');
    expect(replay.map((message) => message.id)).toEqual([sent.message.id]);

    const repeated = await sendPrompt(alpha, bravo.agent, 'send-3', 'still here');
    expect(repeated.message.id).toBe(sent.message.id);
    expect(repeated.idempotentReplay).toBe(true);

    // And the survivor can still answer the original.
    const reply = await send(KEY_B, {
      operation: 'reply',
      agentId: bravo.agent.agentId,
      replyToMessageId: sent.message.id,
      content: 'still here',
      idempotencyKey: 'reply-2',
    });
    expect(reply.status).toBe(200);
    expect((await receiptOf(KEY_A, sent.message.id)).status).toBe('replied');
  });

  it('reports a delivery failure the sender then sees', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');
    const sent = await sendPrompt(alpha, bravo.agent, 'send-4', 'can you take this?');

    // The sender cannot fail its own delivery...
    const bySender = await post(`/v1/messages/${sent.message.id}/failure`, KEY_A, {
      agentId: alpha.agent.agentId,
      errorCode: 'target_not_promptable',
      errorDetail: 'not mine to report',
    });
    expect(bySender.status).toBe(403);
    // ...and another machine cannot reach the message at all.
    await host(KEY_C, 'machine-charlie', 'claude-code:charlie');
    const byStranger = await post(`/v1/messages/${sent.message.id}/failure`, KEY_C, {
      agentId: bravo.agent.agentId,
      errorCode: 'target_not_promptable',
      errorDetail: 'not mine either',
    });
    expect(byStranger.status).toBe(403);

    // The recipient reports what it could not show its session.
    const reported = await post(`/v1/messages/${sent.message.id}/failure`, KEY_B, {
      agentId: bravo.agent.agentId,
      errorCode: 'target_not_promptable',
      errorDetail: 'no session to show it to',
    });
    expect(reported.status).toBe(200);
    const receipt = await receiptOf(KEY_A, sent.message.id);
    expect(receipt.status).toBe('failed');
    expect(receipt.error_code).toBe('target_not_promptable');
  });

  it('keeps the pull endpoint and receiver lease for the machine that owns them', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');

    await connectPullEndpoint(alpha.runtime, alpha.agent, 'claude-code:alpha', 'claude-code', [
      'pull',
    ]);
    await renewReceiver(alpha.runtime, alpha.agent, 90);
    await releaseReceiver(alpha.runtime, alpha.agent);

    // A receiver for an agent with no endpoint is refused rather than invented.
    const orphan = await put(`/v1/agents/${bravo.agent.agentId}/endpoint/receiver`, KEY_B, {
      ttlSeconds: 90,
    });
    expect(orphan.status).toBe(409);
  });

  it('carries no key or message body in its logs', async () => {
    const alpha = await host(KEY_A, 'machine-alpha', 'claude-code:alpha');
    const bravo = await host(KEY_B, 'machine-bravo', 'claude-code:bravo');
    const secretContent = 'the text of a message nobody may log';
    await sendPrompt(alpha, bravo.agent, 'send-5', secretContent);
    await drainCloud(bravo.runtime, bravo.agent, 'drain-5');

    const transcript = logs.join('\n');
    for (const secret of [KEY_A, KEY_B, KEY_C, WRONG_KEY, secretContent]) {
      expect(transcript).not.toContain(secret);
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).toMatch(/^(GET|POST|PUT|DELETE) \/v1\/\S+ \d{3}$/u);
  });
});
