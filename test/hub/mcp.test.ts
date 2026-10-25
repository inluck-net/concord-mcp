import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runHubServe } from '../../src/cli/commands/hub-serve.js';
import { HttpClientTransport } from '../../src/cloud/http-transport.js';
import {
  drainCloud,
  registerCloudAgent,
  type CloudAgentRef,
  type CloudRuntime,
} from '../../src/cloud/runtime.js';
import type { HubServer } from '../../src/hub/server.js';
import { PUBLIC_WORKFLOW_TOOLS } from '../../src/tools/workflow.js';

const KEY_A = 'hub-key-alpha-0123456789';
const KEY_B = 'hub-key-bravo-0123456789';
const KEY_C = 'hub-key-charlie-0123456789';
const WRONG_KEY = 'hub-key-xray-0123456789';

const MACHINE_A = 'machine-alpha';
const MACHINE_B = 'machine-bravo';

const sentShape = z.object({
  message_id: z.string(),
  status: z.string(),
  receipt: z.object({ status: z.string(), ticks: z.string() }).loose(),
  idempotent_replay: z.boolean(),
});

const startedShape = z.object({ task_id: z.string(), status: z.string() }).loose();

const threadShape = z.object({
  scope: z.string(),
  thread: z.array(
    z
      .object({
        messageId: z.string(),
        content: z.string(),
        receipt: z.object({ status: z.string() }).loose(),
      })
      .loose(),
  ),
});

function auth(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
}

describe('hub /mcp workflow tools', () => {
  let dir: string;
  let keyFile: string;
  let dbPath: string;
  let logs: string[];
  let running: HubServer[];
  let hub: HubServer;
  let clients: Client[];

  const log = (line: string): void => {
    logs.push(line);
  };

  /** The client transport the open-source proxy itself uses, at the hub's `/mcp`. */
  async function openMcp(key: string, machineKey: string): Promise<Client> {
    const transport = new HttpClientTransport(new URL(`${hub.url}/mcp`), {
      'x-concord-project': 'github.com/acme/hub-test',
      'x-concord-machine': machineKey,
      Authorization: `Bearer ${key}`,
    });
    const client = new Client({ name: 'hub-mcp-test', version: '0.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

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

  /** A machine and its agent session, registered as the client registers them. */
  async function host(
    key: string,
    machineKey: string,
    agentKey: string,
  ): Promise<{ key: string; runtime: CloudRuntime; agent: CloudAgentRef }> {
    const runtime = runtimeFor(key, machineKey);
    const agent = await registerCloudAgent(runtime, { agentKey, kind: 'claude-code' });
    return { key, runtime, agent };
  }

  async function postMcp(key: string, body: object): Promise<Response> {
    return fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: auth(key),
      body: JSON.stringify(body),
    });
  }

  function toolCall(name: string, args: object): object {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'concord-hub-mcp-'));
    keyFile = join(dir, 'hub-keys.json');
    dbPath = join(dir, 'hub.db');
    logs = [];
    running = [];
    clients = [];
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
    hub = await runHubServe({ port: 0, db: dbPath, keyFile }, { env: {}, log });
    running.push(hub);
  });

  afterEach(async () => {
    for (const client of clients) await client.close();
    for (const server of running) await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes exactly the five workflow tools the local server registers', async () => {
    const alpha = await host(KEY_A, MACHINE_A, 'claude-code:alpha');
    const client = await openMcp(KEY_A, MACHINE_A);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...PUBLIC_WORKFLOW_TOOLS]);

    // The meta advertisement names the same five, for the client's checks.
    const meta = z
      .object({ mcp: z.object({ endpoint: z.string(), tools: z.array(z.string()) }) })
      .parse(await (await fetch(`${hub.url}/v1/meta`)).json());
    expect(meta.mcp.endpoint).toBe('/mcp');
    expect(meta.mcp.tools).toEqual([...PUBLIC_WORKFLOW_TOOLS]);
    expect(alpha.agent.agentId).toBe('claude-code:alpha');
  });

  it('routes start_work to the existing claim handler under the registered agent', async () => {
    await host(KEY_A, MACHINE_A, 'claude-code:alpha');
    const client = await openMcp(KEY_A, MACHINE_A);
    const result = await client.callTool({
      name: 'start_work',
      arguments: {
        task_id: 'TASK-HUB-1',
        agent_id: 'claude-code:alpha',
        kind: 'claude-code',
        title: 'Hub task over MCP',
        expected_files: ['src/hub/server.ts'],
      },
    });
    expect(result.isError).not.toBe(true);
    const started = startedShape.parse(result.structuredContent);
    expect(started.task_id).toMatch(/TASK-/u);
    expect(started.status).not.toBe('');
  });

  it('prompts and replies across machines, and the thread keeps its content private to participants', async () => {
    await host(KEY_A, MACHINE_A, 'claude-code:alpha');
    const bravo = await host(KEY_B, MACHINE_B, 'claude-code:bravo');
    await host(KEY_C, 'machine-charlie', 'claude-code:charlie');
    const fromAlpha = await openMcp(KEY_A, MACHINE_A);
    const fromBravo = await openMcp(KEY_B, MACHINE_B);
    const fromCharlie = await openMcp(KEY_C, 'machine-charlie');

    const secret = 'the prompt body only its two agents may read';
    const prompted = await fromAlpha.callTool({
      name: 'update_work',
      arguments: {
        operation: 'prompt',
        agent_id: 'claude-code:alpha',
        to_agent_id: 'claude-code:bravo',
        content: secret,
        idempotency_key: 'mcp-prompt-1',
      },
    });
    expect(prompted.isError).not.toBe(true);
    const sent = sentShape.parse(prompted.structuredContent);
    expect(sent.status).toBe('sent');

    // The recipient takes it through its own inbox path, then answers.
    const delivered = await drainCloud(bravo.runtime, bravo.agent, 'mcp-drain-1');
    expect(delivered.map((message) => message.content)).toEqual([secret]);

    const replied = await fromBravo.callTool({
      name: 'update_work',
      arguments: {
        operation: 'reply',
        agent_id: 'claude-code:bravo',
        reply_to_message_id: sent.message_id,
        content: 'answered',
        idempotency_key: 'mcp-reply-1',
      },
    });
    expect(replied.isError).not.toBe(true);
    // The reply is its own message; the one it answers is marked answered.
    const answer = sentShape.parse(replied.structuredContent);
    expect(answer.message_id).not.toBe(sent.message_id);

    // The sender inspects its own thread: two messages, receipts and all.
    const seen = await fromAlpha.callTool({
      name: 'inspect_work',
      arguments: { message_id: sent.message_id, agent_id: 'claude-code:alpha' },
    });
    const thread = threadShape.parse(seen.structuredContent);
    expect(thread.thread.map((message) => message.content).sort()).toEqual(['answered', secret]);
    const parent = thread.thread.find((message) => message.messageId === sent.message_id);
    expect(parent?.receipt.status).toBe('replied');

    // A third machine's agent shares none of it.
    const snooped = await fromCharlie.callTool({
      name: 'inspect_work',
      arguments: { message_id: sent.message_id, agent_id: 'claude-code:charlie' },
    });
    expect(snooped.isError).toBe(true);
    expect(JSON.stringify(snooped)).not.toContain(secret);
    expect(JSON.stringify(snooped)).not.toContain('answered');

    // And inspecting another agent's inbox shows its presence, not its mail.
    const inbox = await fromAlpha.callTool({
      name: 'inspect_work',
      arguments: { agent_id: 'claude-code:bravo' },
    });
    const view = z.object({ private: z.boolean() }).loose().parse(inbox.structuredContent);
    expect(view.private).toBe(true);
    expect(JSON.stringify(inbox)).not.toContain(secret);
    expect(JSON.stringify(inbox)).not.toContain('answered');
  });

  it('refuses a model-supplied agent_id that belongs to another machine', async () => {
    await host(KEY_A, MACHINE_A, 'claude-code:alpha');
    const bravo = await host(KEY_B, MACHINE_B, 'claude-code:bravo');
    const fromBravo = await openMcp(KEY_B, MACHINE_B);

    // Neither a write nor a read may be *made as* another machine's agent.
    await expect(
      fromBravo.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          agent_id: 'claude-code:alpha',
          to_agent_id: 'claude-code:bravo',
          content: 'forged',
          idempotency_key: 'forged-1',
        },
      }),
    ).rejects.toThrow();
    await expect(
      fromBravo.callTool({
        name: 'inspect_work',
        arguments: { message_id: 'msg-1', agent_id: 'claude-code:alpha' },
      }),
    ).rejects.toThrow();

    // Looking at another machine's agent is allowed — its presence, never its
    // mail, exactly as `docs/messaging-v2.md` prescribes.
    const presence = await fromBravo.callTool({
      name: 'inspect_work',
      arguments: { agent_id: 'claude-code:alpha' },
    });
    expect(presence.isError).not.toBe(true);
    const view = z.object({ private: z.boolean() }).loose().parse(presence.structuredContent);
    expect(view.private).toBe(true);
    expect(JSON.stringify(presence)).not.toContain('forged');

    // The HTTP answer is a refusal, and it names no key and no content.
    const forged = await postMcp(
      KEY_B,
      toolCall('update_work', {
        operation: 'prompt',
        agent_id: 'claude-code:alpha',
        to_agent_id: 'claude-code:bravo',
        content: 'forged',
        idempotency_key: 'forged-2',
      }),
    );
    expect(forged.status).toBe(403);
    const detail = await forged.text();
    expect(detail).not.toContain(KEY_A);
    expect(detail).not.toContain('forged');

    // Nothing was sent under the forged actor.
    expect(await drainCloud(bravo.runtime, bravo.agent, 'mcp-drain-forged')).toEqual([]);
  });

  it('refuses unauthenticated calls and unregistered agents, and registers only with start_work', async () => {
    await host(KEY_A, MACHINE_A, 'claude-code:alpha');

    const anonymous = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: auth(WRONG_KEY),
      body: JSON.stringify(toolCall('inspect_work', {})),
    });
    expect(anonymous.status).toBe(401);

    const unregistered = await postMcp(
      KEY_A,
      toolCall('update_work', {
        operation: 'prompt',
        agent_id: 'claude-code:nobody',
        to_agent_id: 'claude-code:alpha',
        content: 'from nobody',
        idempotency_key: 'nobody-1',
      }),
    );
    expect(unregistered.status).toBe(403);

    // A write that names no agent is refused by the handlers' own rule.
    const client = await openMcp(KEY_A, MACHINE_A);
    const nameless = await client.callTool({
      name: 'update_work',
      arguments: {
        operation: 'prompt',
        to_agent_id: 'claude-code:alpha',
        content: 'from nobody',
        idempotency_key: 'nobody-2',
      },
    });
    expect(nameless.isError).toBe(true);

    // `start_work` is the call that registers an agent, so a session its hooks
    // never registered can still introduce itself — on its own machine only.
    const introduced = await client.callTool({
      name: 'start_work',
      arguments: {
        task_id: 'TASK-HUB-2',
        agent_id: 'claude-code:gamma',
        kind: 'claude-code',
        title: 'A second session on this machine',
      },
    });
    expect(introduced.isError).not.toBe(true);
    expect(startedShape.parse(introduced.structuredContent).task_id).toMatch(/TASK-/u);
  });

  it('carries no key or message body in its logs', async () => {
    const secret = 'a prompt body that must never reach a log line';
    await host(KEY_A, MACHINE_A, 'claude-code:alpha');
    await host(KEY_B, MACHINE_B, 'claude-code:bravo');
    const fromAlpha = await openMcp(KEY_A, MACHINE_A);
    await fromAlpha.callTool({
      name: 'update_work',
      arguments: {
        operation: 'prompt',
        agent_id: 'claude-code:alpha',
        to_agent_id: 'claude-code:bravo',
        content: secret,
        idempotency_key: 'mcp-log-1',
      },
    });
    await postMcp(WRONG_KEY, toolCall('inspect_work', {}));

    const transcript = logs.join('\n');
    for (const hidden of [KEY_A, KEY_B, KEY_C, WRONG_KEY, secret]) {
      expect(transcript).not.toContain(hidden);
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).toMatch(/^(GET|POST|PUT|DELETE) \/\S+ \d{3}$/u);
  });
});
