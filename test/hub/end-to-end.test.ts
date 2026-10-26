import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cloudAccess,
  drainFromCloud,
  registerInCloud,
} from '../../src/cli/commands/cloud-inbox.js';
import {
  runHubConnect,
  runHubLink,
  type HubClientDeps,
} from '../../src/cli/commands/hub-client.js';
import { runHubServe } from '../../src/cli/commands/hub-serve.js';
import { drainInbox } from '../../src/cli/commands/inbox.js';
import {
  cloudSessionFor,
  connectCloud,
  createCloudProxyServer,
  type CloudSession,
} from '../../src/cloud/proxy.js';
import { cloudTargetFor } from '../../src/cloud/target.js';
import { createRepositories, openDatabase, type Repositories } from '../../src/db/index.js';
import { ensureAgentRegistered } from '../../src/tools/register-agent.js';
import { createServer } from '../../src/server.js';
import type { HubServer } from '../../src/hub/server.js';

const KEY_A = 'hub-key-alpha-0123456789';
const KEY_B = 'hub-key-bravo-0123456789';
const KEY_C = 'hub-key-charlie-0123456789';
const ORIGIN = () => 'git@github.com:Acme/App.git';
const SECRET = 'a prompt only its two agents may read';

const sentShape = z
  .object({
    message_id: z.string(),
    receipt: z.object({ status: z.string() }).loose(),
    idempotent_replay: z.boolean(),
  })
  .loose();

const threadShape = z
  .object({
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
  })
  .loose();

const presenceShape = z
  .object({ scope: z.string(), presence: z.array(z.object({ agentId: z.string() }).loose()) })
  .loose();

/** The message of a run that must refuse. */
async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the request to fail');
}

function clientDeps(home: string, repo: string, key: string, machine: string): HubClientDeps {
  return {
    env: { HOME: home },
    fetch,
    cwd: repo,
    readStdin: () => Promise.resolve(`${key}\n`),
    hostname: () => `host-${machine}`,
    newMachineKey: () => machine,
    originRemote: ORIGIN,
  };
}

/** A harness session over its machine's hub connection, as a client starts one. */
async function openSession(
  repo: string,
  env: NodeJS.ProcessEnv,
  agentId: string,
): Promise<{ session: CloudSession; harness: Client }> {
  const session = cloudSessionFor(
    repo,
    env,
    { agentId, kind: 'claude-code', origin: 'session' },
    repo,
  );
  if (session === undefined) throw new Error(`${repo} is not on the private hub`);
  const proxy = createCloudProxyServer(session, () => connectCloud(session, fetch));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverSide);
  const harness = new Client({ name: `harness-${agentId}`, version: '0.0.0' });
  await harness.connect(clientSide);
  return { session, harness };
}

function messagesIn(repo: string, agentId: string): string[] {
  const dbPath = join(repo, '.concord', 'concord.db');
  if (!existsSync(dbPath)) return [];
  const repos = createRepositories(openDatabase(dbPath));
  try {
    return repos.agentMessages.listByAgent(agentId).map((message) => message.content);
  } finally {
    repos.db.close();
  }
}

describe('two clients on a private hub', () => {
  let dir: string;
  let hub: HubServer;
  let sessionA: CloudSession;
  let sessionB: CloudSession;
  let harnessA: Client;
  let harnessB: Client;
  let repoA: string;
  let repoB: string;
  let repoC: string;
  let homeA: string;
  let homeB: string;
  let homeC: string;
  let closers: (() => Promise<void>)[];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'concord-hub-e2e-'));
    closers = [];
    const keyFile = join(dir, 'hub-keys.json');
    writeFileSync(
      keyFile,
      `${JSON.stringify(
        {
          machines: [
            { key: KEY_A, name: 'alpha' },
            { key: KEY_B, name: 'bravo' },
            { key: KEY_C, name: 'charlie' },
          ],
        },
        null,
        2,
      )}\n`,
    );
    hub = await runHubServe(
      { port: 0, db: join(dir, 'hub.db'), keyFile },
      { env: {}, log: () => undefined },
    );
    closers.push(() => hub.close());

    // Two machines, two homes, two workspaces — joined through the CLI only.
    homeA = join(dir, 'home-a');
    homeB = join(dir, 'home-b');
    homeC = join(dir, 'home-c');
    repoA = join(dir, 'repo-a');
    repoB = join(dir, 'repo-b');
    repoC = join(dir, 'repo-c');
    for (const folder of [homeA, homeB, homeC, repoA, repoB, repoC]) {
      mkdirSync(folder, { recursive: true });
    }
    for (const repo of [repoA, repoB, repoC]) mkdirSync(join(repo, '.git'), { recursive: true });

    const depsA = clientDeps(homeA, repoA, KEY_A, 'machine-a');
    const depsB = clientDeps(homeB, repoB, KEY_B, 'machine-b');
    await runHubConnect({ url: hub.url, keyStdin: true }, depsA);
    await runHubConnect({ url: hub.url, keyStdin: true }, depsB);
    await runHubLink({ project: undefined, replaceLocal: false }, depsA);
    await runHubLink({ project: undefined, replaceLocal: false }, depsB);

    // Two agent sessions, registered the way a session start registers them.
    const openedA = await openSession(repoA, { HOME: homeA }, 'claude-code:alpha');
    const openedB = await openSession(repoB, { HOME: homeB }, 'claude-code:bravo');
    sessionA = openedA.session;
    sessionB = openedB.session;
    harnessA = openedA.harness;
    harnessB = openedB.harness;
    closers.push(
      () => harnessA.close(),
      () => harnessB.close(),
    );
    await registerInCloud({ ...sessionA, fetch }, 'claude-code:alpha', 'claude-code', repoA);
    await registerInCloud({ ...sessionB, fetch }, 'claude-code:bravo', 'claude-code', repoB);
  });

  afterAll(async () => {
    for (const close of closers) await close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers, prompts, drains, replies and reports the receipt progression', async () => {
    // Discovery: each session sees the other's presence.
    const presence = presenceShape.parse(
      (await harnessA.callTool({ name: 'inspect_work', arguments: {} })).structuredContent,
    );
    expect(presence.presence.map((entry) => entry.agentId).sort()).toEqual([
      'claude-code:alpha',
      'claude-code:bravo',
    ]);

    // A prompt, sent once however often its key is repeated.
    const prompt = {
      operation: 'prompt',
      agent_id: 'claude-code:alpha',
      to_agent_id: 'claude-code:bravo',
      content: SECRET,
      idempotency_key: 'e2e-1',
    };
    const sent = sentShape.parse(
      (await harnessA.callTool({ name: 'update_work', arguments: prompt })).structuredContent,
    );
    expect(sent.receipt.status).toBe('sent');
    const repeated = sentShape.parse(
      (await harnessA.callTool({ name: 'update_work', arguments: prompt })).structuredContent,
    );
    expect(repeated.idempotent_replay).toBe(true);
    expect(repeated.message_id).toBe(sent.message_id);

    // The recipient's own inbox path takes it: ✓✓, once.
    const drained = await drainFromCloud(
      { ...sessionB, fetch },
      'claude-code:bravo',
      'claude-code',
    );
    expect(drained.map((message) => message.content)).toEqual([SECRET]);
    expect(drained[0]).toMatchObject({
      messageId: sent.message_id,
      senderAgentId: 'claude-code:alpha',
      messageKind: 'prompt',
    });

    // Receipts move as the messaging contract says: sent → delivered.
    const afterDrain = threadShape.parse(
      (
        await harnessA.callTool({
          name: 'inspect_work',
          arguments: { message_id: sent.message_id, agent_id: 'claude-code:alpha' },
        })
      ).structuredContent,
    );
    const parent = afterDrain.thread.find((message) => message.messageId === sent.message_id);
    expect(parent?.receipt.status).toBe('delivered');

    // The answer, from the recipient's own session.
    const answer = sentShape.parse(
      (
        await harnessB.callTool({
          name: 'update_work',
          arguments: {
            operation: 'reply',
            agent_id: 'claude-code:bravo',
            reply_to_message_id: sent.message_id,
            content: 'answered',
            idempotency_key: 'e2e-2',
          },
        })
      ).structuredContent,
    );
    expect(answer.message_id).not.toBe(sent.message_id);

    // And the original shows its reply: sent → delivered → replied.
    const afterReply = threadShape.parse(
      (
        await harnessA.callTool({
          name: 'inspect_work',
          arguments: { message_id: sent.message_id, agent_id: 'claude-code:alpha' },
        })
      ).structuredContent,
    );
    expect(afterReply.thread.map((message) => message.content).sort()).toEqual(
      [SECRET, 'answered'].sort(),
    );
    expect(
      afterReply.thread.find((message) => message.messageId === sent.message_id)?.receipt.status,
    ).toBe('replied');
  });

  it('keeps a workspace with local state on local Concord', async () => {
    // Machine C is connected to the same hub, but this workspace holds local
    // state and is never linked: it stays local, and says so.
    const depsC = clientDeps(homeC, repoC, KEY_C, 'machine-c');
    await runHubConnect({ url: hub.url, keyStdin: true }, depsC);
    const dbPath = join(repoC, '.concord', 'concord.db');
    mkdirSync(join(repoC, '.concord'), { recursive: true });
    const local = openDatabase(dbPath);
    const repos: Repositories = createRepositories(local);
    try {
      expect(cloudTargetFor(repoC, depsC.env, ORIGIN)).toBeUndefined();
      expect(cloudSessionFor(repoC, depsC.env, undefined, repoC)).toBeUndefined();
      expect(cloudAccess(repoC, {}, depsC.env).kind).toBe('local');

      // Local messaging still works, through the local MCP server.
      const server = createServer(repos, {
        identity: { agentId: 'claude-code:local-a', kind: 'claude-code', origin: 'session' },
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      const localHarness = new Client({ name: 'local-harness', version: '0.0.0' });
      await localHarness.connect(clientSide);
      try {
        // The server is local-a's session (its actor is stamped, not the
        // model's), so the recipient is registered the way an inbox does it.
        ensureAgentRegistered(repos, {
          agentId: 'claude-code:local-b',
          kind: 'claude-code',
        });
        await localHarness.callTool({
          name: 'start_work',
          arguments: {
            task_id: 'TASK-A',
            title: 'local work',
            kind: 'claude-code',
            agent_id: 'claude-code:local-a',
          },
        });
        const localMessage = sentShape.parse(
          (
            await localHarness.callTool({
              name: 'update_work',
              arguments: {
                operation: 'prompt',
                agent_id: 'claude-code:local-a',
                to_agent_id: 'claude-code:local-b',
                content: 'local hello',
                idempotency_key: 'local-1',
              },
            })
          ).structuredContent,
        );
        expect(
          drainInbox(repos, 'claude-code:local-b', 'claude-code').map((message) => message.content),
        ).toEqual(['local hello']);

        // The hub never saw it: that message does not exist there.
        const onHub = await harnessA.callTool({
          name: 'inspect_work',
          arguments: {
            message_id: localMessage.message_id,
            agent_id: 'claude-code:alpha',
          },
        });
        expect(onHub.isError).toBe(true);
      } finally {
        await localHarness.close();
        await server.close();
      }
    } finally {
      repos.db.close();
    }
  });

  it('reports a hub outage as retryable and never delivers to a local recipient', async () => {
    // A local decoy named as the hub's recipient: a silent fallback would land
    // in its inbox.
    const localA = createRepositories(openDatabase(join(repoA, '.concord', 'concord.db')));
    try {
      ensureAgentRegistered(localA, { agentId: 'claude-code:bravo', kind: 'claude-code' });
      await hub.close();

      // The recipient's inbox path says the hub could not be reached, and to
      // try again — not that its inbox is empty.
      const drained = await failureOf(
        drainFromCloud({ ...sessionB, fetch }, 'claude-code:bravo', 'claude-code'),
      );
      expect(drained).toContain('could not be reached');
      expect(drained).toContain('try again');

      // A prompt fails visibly the same way, and stays on the hub's routing.
      const failed = await harnessA.callTool({
        name: 'update_work',
        arguments: {
          operation: 'prompt',
          agent_id: 'claude-code:alpha',
          to_agent_id: 'claude-code:bravo',
          content: 'while the hub is down',
          idempotency_key: 'e2e-down',
        },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain('could not be reached');
      expect(cloudAccess(repoA, {}, { HOME: homeA }).kind).toBe('cloud');

      // Nothing reached a different local recipient, here or at the decoy.
      expect(localA.agentMessages.listByAgent('claude-code:bravo')).toEqual([]);
      expect(messagesIn(repoB, 'claude-code:bravo')).toEqual([]);
    } finally {
      localA.db.close();
    }
  });
});
