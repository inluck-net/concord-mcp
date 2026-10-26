import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  registerHubClientCommand,
  runHubConnect,
  runHubLink,
  runHubStatus,
  runHubUnlink,
  type HubClientDeps,
} from '../../src/cli/commands/hub-client.js';
import { registerHubCommand, runHubServe } from '../../src/cli/commands/hub-serve.js';
import { checkKey, REQUIRED_CAPABILITIES, type Fetch } from '../../src/cloud/client.js';
import {
  credentialsPath,
  machinePath,
  readCredentials,
  readLink,
} from '../../src/cloud/settings.js';
import { cloudTargetFor } from '../../src/cloud/target.js';
import { createRepositories, openDatabase } from '../../src/db/index.js';
import type { HubServer } from '../../src/hub/server.js';

const KEY = 'hub-key-alpha-0123456789';

const META = {
  apiVersion: 1,
  capabilities: [...REQUIRED_CAPABILITIES],
  mcp: { endpoint: '/mcp', tools: [] },
};

const machineList = z.object({
  machines: z.array(z.object({ machineKey: z.string(), name: z.string(), hostname: z.string() })),
});

/** The message of a run that must refuse. */
async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the command to refuse');
}

describe('concord hub client commands', () => {
  let dir: string;
  let home: string;
  let repo: string;
  let hub: HubServer[];
  let deps: HubClientDeps;
  let minted: number;

  /** A private hub with one machine key, beside this test's client home. */
  async function startHub(): Promise<HubServer> {
    const keyFile = join(dir, 'hub-keys.json');
    writeFileSync(
      keyFile,
      `${JSON.stringify({ machines: [{ key: KEY, name: 'alpha' }] }, null, 2)}\n`,
    );
    const running = await runHubServe(
      { port: 0, db: join(dir, 'hub.db'), keyFile },
      { env: {}, log: () => undefined },
    );
    hub.push(running);
    return running;
  }

  /** The workspace's own local database, with one task in it. */
  function writeLocalState(): string {
    const dbPath = join(repo, '.concord', 'concord.db');
    mkdirSync(join(repo, '.concord'), { recursive: true });
    const local = openDatabase(dbPath);
    createRepositories(local).tasks.create({
      taskId: 'TASK-1',
      title: 'local work',
      owner: null,
      agent: null,
      branch: null,
      worktree: null,
      expectedFiles: [],
      modules: [],
      domains: [],
      riskTags: [],
      notes: null,
      parentTaskId: null,
      agentId: null,
    });
    local.close();
    return dbPath;
  }

  function localTask(): string | undefined {
    const reopened = openDatabase(join(repo, '.concord', 'concord.db'));
    try {
      return createRepositories(reopened).tasks.get('TASK-1')?.title;
    } finally {
      reopened.close();
    }
  }

  const ORIGIN = () => 'git@github.com:Acme/App.git';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'concord-hub-client-'));
    home = join(dir, 'home');
    repo = join(dir, 'repo');
    mkdirSync(home);
    mkdirSync(join(repo, '.git'), { recursive: true });
    hub = [];
    minted = 0;
    deps = {
      env: { HOME: home },
      fetch,
      cwd: repo,
      readStdin: () => Promise.resolve(`${KEY}\n`),
      hostname: () => 'devbox',
      newMachineKey: () => `machine-${String(++minted)}`,
      originRemote: ORIGIN,
    };
  });

  afterEach(async () => {
    for (const running of hub) await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('connects to a private hub, registers this machine, and never prints the key', async () => {
    const server = await startHub();

    const out = await runHubConnect({ url: server.url, keyStdin: true }, deps);
    expect(out).toContain(server.url);
    expect(out).toContain('private hub');
    expect(out).toContain('machine-1');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY.slice(0, 8));

    // The key is saved here, readable only by this user, and the output above
    // is the only thing a person saw.
    const saved = credentialsPath(deps.env);
    expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual({
      apiUrl: server.url,
      apiKey: KEY,
      scope: 'hub',
    });
    if (process.platform !== 'win32') expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(machinePath(deps.env), 'utf8'))).toEqual({
      machineKey: 'machine-1',
    });

    // The hub really holds this machine's registration under the key's own.
    const listed = await fetch(`${server.url}/v1/machines`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const machines = machineList.parse(await listed.json()).machines;
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ machineKey: 'machine-1', hostname: 'devbox' });
    expect(await checkKey(server.url, KEY)).toBe('ok');
  });

  it('keeps a fresh repository local until explicitly linked, then restores local mode', async () => {
    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);

    expect(cloudTargetFor(repo, deps.env, ORIGIN)).toBeUndefined();

    await runHubLink({ project: undefined, replaceLocal: false }, deps);
    expect(cloudTargetFor(repo, deps.env, ORIGIN)).toEqual({
      apiUrl: server.url,
      projectKey: 'github.com/acme/app',
      source: 'link',
    });

    runHubUnlink(deps);
    expect(cloudTargetFor(repo, deps.env, ORIGIN)).toBeUndefined();
  });

  it('rejects a remote plaintext URL before sending the key anywhere', async () => {
    const sent: string[] = [];
    const spy: Fetch = (input) => {
      sent.push(input);
      return Promise.reject(new Error('the key must not travel to a plaintext URL'));
    };

    const failure = await runHubConnect(
      { url: 'http://198.51.100.10:8787', keyStdin: true },
      { ...deps, fetch: spy },
    ).then(
      () => 'connected',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toMatch(/https/u);
    expect(failure).not.toContain(KEY);
    expect(sent).toEqual([]);
    expect(readCredentials(deps.env)).toBeUndefined();
  });

  it('takes an https URL and a piped key even when the hub offers a browser sign-in', async () => {
    const sent: string[] = [];
    const offering: Fetch = (input) => {
      sent.push(input);
      if (input.endsWith('/v1/meta')) {
        return Promise.resolve(
          Response.json({
            ...META,
            cliLogin: {
              authorizationEndpoint: 'https://auth.hub.test/authorize',
              tokenEndpoint: 'https://auth.hub.test/token',
              clientId: 'cli-client',
              redirectUri: 'https://hub.test/cli/callback',
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ machine: { id: 'm-1' } }));
    };

    const out = await runHubConnect(
      { url: 'https://hub.example.test', keyStdin: true },
      { ...deps, fetch: offering },
    );
    expect(out).toContain('https://hub.example.test');
    expect(out).not.toContain(KEY);
    expect(sent).toEqual([
      'https://hub.example.test/v1/meta',
      'https://hub.example.test/v1/machines',
    ]);

    // And with no key at all the command refuses: a private hub has no browser
    // sign-in to fall back to.
    const noKey = await runHubConnect(
      { url: 'https://hub.example.test', keyStdin: false },
      { ...deps, env: { HOME: home }, fetch: offering, readStdin: () => Promise.resolve('') },
    ).then(
      () => 'connected',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(noKey).toMatch(/browser sign-in for a private hub/u);
  });

  it('refuses a URL that is not a Concord API, or not this runtime’s version', async () => {
    const wrongShape: Fetch = (input) =>
      Promise.resolve(
        input.endsWith('/v1/meta') ? Response.json({ hello: 'world' }) : Response.json({}),
      );
    const shape = await runHubConnect(
      { url: 'https://hub.example.test', keyStdin: true },
      { ...deps, fetch: wrongShape },
    ).then(
      () => 'connected',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(shape).toMatch(/v1\/meta|Concord API/u);
    expect(shape).not.toContain(KEY);

    const wrongVersion: Fetch = (input) =>
      Promise.resolve(
        input.endsWith('/v1/meta')
          ? Response.json({ ...META, apiVersion: 2 })
          : Response.json({ machine: { id: 'm-1' } }),
      );
    const version = await runHubConnect(
      { url: 'https://hub.example.test', keyStdin: true },
      { ...deps, fetch: wrongVersion },
    ).then(
      () => 'connected',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(version).toMatch(/as a private hub/u);
    expect(version).toMatch(/version/u);
    expect(version).not.toContain(KEY);
    expect(readCredentials(deps.env)).toBeUndefined();
  });

  it('reports the hub and this machine’s identity without showing secrets', async () => {
    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);

    const out = await runHubStatus(deps);
    expect(out).toContain(server.url);
    expect(out).toContain('private hub');
    expect(out).toContain('machine-1');
    expect(out).toContain('Key: accepted');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY.slice(0, 8));
  });

  it('reports no hub before connecting, and one it cannot reach after', async () => {
    const before = await runHubStatus(deps);
    expect(before).toContain('Hub: none');
    expect(before).toContain('Machine: none');
    expect(before).not.toContain(KEY);

    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);
    const unreachable = await runHubStatus({
      ...deps,
      fetch: () => Promise.reject(new TypeError('connection refused')),
    });
    expect(unreachable).toContain(server.url);
    expect(unreachable).toContain('unreachable');
    expect(unreachable).not.toContain(KEY);
    // The saved key and identity survive the outage untouched.
    expect(readCredentials(deps.env)).toEqual({ apiUrl: server.url, apiKey: KEY, scope: 'hub' });
    expect(unreachable).toContain('machine-1');
  });

  it('refuses to link a workspace that holds local state, and touches none of it', async () => {
    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);
    writeLocalState();

    const message = await failureOf(runHubLink({ project: undefined, replaceLocal: false }, deps));
    expect(message).toContain('holds local Concord state');
    expect(message).toContain('--replace-local');
    expect(message).toContain('without moving or deleting');
    // Nothing moved, nothing linked.
    expect(localTask()).toBe('local work');
    expect(readLink(repo)).toBeUndefined();
  });

  it('links over local state when told to, and the link wins the routing', async () => {
    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);
    writeLocalState();

    const out = await runHubLink({ project: undefined, replaceLocal: true }, deps);
    expect(out).toContain('private hub');
    expect(out).toContain('github.com/acme/app');
    expect(out).toContain('local database is left in place');
    expect(readLink(repo)).toEqual({
      apiUrl: server.url,
      projectKey: 'github.com/acme/app',
    });

    // Explicit link precedence: the link is what the target routing uses, ahead
    // of the machine's signed-in default and ahead of local state.
    expect(cloudTargetFor(repo, deps.env, ORIGIN)).toEqual({
      apiUrl: server.url,
      projectKey: 'github.com/acme/app',
      source: 'link',
    });
    expect(localTask()).toBe('local work');
  });

  it('unlinks back to local mode, with the local database still readable and the hub untouched', async () => {
    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);
    writeLocalState();
    await runHubLink({ project: undefined, replaceLocal: true }, deps);

    const out = runHubUnlink(deps);
    expect(out).toContain('works locally again');
    expect(out).toContain('untouched');

    // Local mode, not the machine's default: the workspace stays local even
    // though this machine is still connected to the private hub.
    expect(cloudTargetFor(repo, deps.env, ORIGIN)).toBeUndefined();
    expect(localTask()).toBe('local work');
    // The hub keeps its state: the machine's login and registration survive.
    expect(readCredentials(deps.env)).toEqual({ apiUrl: server.url, apiKey: KEY, scope: 'hub' });
    expect(await checkKey(server.url, KEY)).toBe('ok');

    // Unlinking again is a no-op, and a workspace that was never linked says so.
    expect(runHubUnlink(deps)).toContain('already works locally');
  });

  it('reports a hub it cannot reach as retryable, and links nothing', async () => {
    const server = await startHub();
    await runHubConnect({ url: server.url, keyStdin: true }, deps);

    const message = await failureOf(
      runHubLink(
        { project: undefined, replaceLocal: false },
        { ...deps, fetch: () => Promise.reject(new TypeError('connection refused')) },
      ),
    );
    expect(message).toContain('could not be reached');
    expect(message).toContain('try again');
    expect(message).not.toContain(KEY);
    expect(readLink(repo)).toBeUndefined();
  });

  it('refuses to link before this machine is connected, in hub words', async () => {
    const message = await failureOf(runHubLink({ project: undefined, replaceLocal: false }, deps));
    expect(message).toContain('concord hub connect');
    expect(message).not.toMatch(/Concord Cloud/iu);
    expect(readLink(repo)).toBeUndefined();
  });

  it('hangs the workspace commands off the hub group and calls it a private hub', () => {
    const program = new Command();
    program.exitOverride();
    registerHubCommand(program, {
      env: { HOME: home },
      write: () => undefined,
      fail: () => undefined,
      waitForStop: () => Promise.resolve(),
    });
    registerHubClientCommand(program);
    const hub = program.commands.find((command) => command.name() === 'hub');
    expect(hub?.commands.map((command) => command.name()).sort()).toEqual([
      'connect',
      'link',
      'serve',
      'status',
      'unlink',
    ]);

    // AC-2: help calls this a private hub, and never points at a Cloud account.
    const help = [
      hub?.description() ?? '',
      ...(hub?.commands.map((command) => command.description()) ?? []),
    ].join('\n');
    expect(help).toContain('private hub');
    expect(help).not.toMatch(/Concord Cloud/iu);
    expect(help).not.toMatch(/account/iu);
  });
});
