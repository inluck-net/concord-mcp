import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { runHubServe } from '../../src/cli/commands/hub-serve.js';
import {
  checkKey,
  fetchMeta,
  incompatibility,
  registerMachine,
  REQUIRED_CAPABILITIES,
  type MachineRegistration,
} from '../../src/cloud/client.js';
import { keyFingerprint } from '../../src/hub/keys.js';
import { HUB_MCP_TOOLS } from '../../src/hub/meta.js';
import type { HubServer } from '../../src/hub/server.js';
import { openHubStore } from '../../src/hub/store.js';

const KEY_A = 'hub-key-alpha-0123456789';
const KEY_B = 'hub-key-bravo-0123456789';
const WRONG_KEY = 'hub-key-xray-0123456789';

const MACHINE_A: MachineRegistration = {
  machineKey: 'machine-alpha',
  name: 'alpha',
  hostname: 'alpha-host',
  platform: 'darwin',
  runtimeVersion: '0.16.0',
};
const MACHINE_B: MachineRegistration = {
  machineKey: 'machine-bravo',
  name: 'bravo',
  hostname: 'bravo-host',
  platform: 'win32',
  runtimeVersion: '0.16.0',
};

const machineView = z.object({
  id: z.string(),
  machineKey: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  runtimeVersion: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
const machineList = z.object({ machines: z.array(machineView) });
const registeredBody = z.object({ machine: machineView });

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/** Registers as the client does, and reads back the id the hub assigned. */
async function postMachine(
  hub: HubServer,
  key: string,
  body: MachineRegistration,
): Promise<{ status: number; machineId: string | undefined }> {
  const response = await fetch(`${hub.url}/v1/machines`, {
    method: 'POST',
    headers: auth(key),
    body: JSON.stringify(body),
  });
  if (response.status !== 200) return { status: response.status, machineId: undefined };
  const parsed = registeredBody.parse(await response.json());
  return { status: 200, machineId: parsed.machine.id };
}

async function machinesOf(hub: HubServer, key: string): Promise<z.infer<typeof machineView>[]> {
  const response = await fetch(`${hub.url}/v1/machines`, { headers: auth(key) });
  expect(response.status).toBe(200);
  return machineList.parse(await response.json()).machines;
}

async function onlyMachineOf(hub: HubServer, key: string): Promise<z.infer<typeof machineView>> {
  const machines = await machinesOf(hub, key);
  expect(machines).toHaveLength(1);
  const machine = machines[0];
  if (machine === undefined) throw new Error('expected one machine under that key');
  return machine;
}

/** The message of a run that must refuse to start. */
async function failureOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the hub to refuse to start');
}

describe('concord hub machine identity', () => {
  let dir: string;
  let keyFile: string;
  let dbPath: string;
  let logs: string[];
  let running: HubServer[];

  const log = (line: string): void => {
    logs.push(line);
  };

  /** A hub over the key file and SQLite file this test named. */
  async function serve(port = 0): Promise<HubServer> {
    const hub = await runHubServe({ port, db: dbPath, keyFile }, { env: {}, log });
    running.push(hub);
    return hub;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'concord-hub-'));
    keyFile = join(dir, 'hub-keys.json');
    dbPath = join(dir, 'hub.db');
    logs = [];
    running = [];
    writeFileSync(
      keyFile,
      `${JSON.stringify(
        { machines: [{ key: KEY_A, name: 'alpha-label' }, { key: KEY_B }] },
        null,
        2,
      )}\n`,
    );
  });

  afterEach(async () => {
    for (const hub of running) await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves /v1/meta the existing client accepts, and no key is needed for it', async () => {
    const hub = await serve();
    const meta = await fetchMeta(hub.url);
    expect(incompatibility(meta)).toBeNull();
    expect(meta.apiVersion).toBe(1);
    expect(meta.capabilities).toEqual([...REQUIRED_CAPABILITIES]);
    expect(meta.mcp.endpoint).toBe('/mcp');
    expect(meta.mcp.tools).toEqual([...HUB_MCP_TOOLS]);
    expect(HUB_MCP_TOOLS).toEqual([
      'start_work',
      'inspect_work',
      'update_work',
      'transfer_work',
      'finish_work',
    ]);
  });

  it('refuses unauthenticated and wrong-key requests', async () => {
    const hub = await serve();
    const bare = await fetch(`${hub.url}/v1/machines`);
    expect(bare.status).toBe(401);

    const wrong = await fetch(`${hub.url}/v1/machines`, { headers: auth(WRONG_KEY) });
    expect(wrong.status).toBe(401);
    const detail = await wrong.text();
    expect(detail).not.toContain(WRONG_KEY);
    expect(detail).not.toContain(KEY_A);

    expect(await checkKey(hub.url, WRONG_KEY)).toBe('rejected');
    expect(await registerMachine(hub.url, WRONG_KEY, MACHINE_A)).toBe('rejected');
    expect(await checkKey(hub.url, KEY_A)).toBe('ok');
  });

  it('binds a key to one machine and refuses every other pairing', async () => {
    const hub = await serve();
    expect(await registerMachine(hub.url, KEY_A, MACHINE_A)).toBe('ok');
    expect(await registerMachine(hub.url, KEY_B, MACHINE_B)).toBe('ok');

    const seenByA = await machinesOf(hub, KEY_A);
    expect(seenByA.map((machine) => machine.machineKey)).toEqual(['machine-alpha']);
    const seenByB = await machinesOf(hub, KEY_B);
    expect(seenByB.map((machine) => machine.machineKey)).toEqual(['machine-bravo']);

    // The key file's label names the machine; a key with no label keeps the
    // name its machine reported.
    expect(await onlyMachineOf(hub, KEY_A)).toMatchObject({
      machineKey: 'machine-alpha',
      name: 'alpha-label',
      hostname: 'alpha-host',
    });
    expect(await onlyMachineOf(hub, KEY_B)).toMatchObject({
      machineKey: 'machine-bravo',
      name: 'bravo',
    });

    // One key identifies one machine: a second machine under it is refused...
    const second = await postMachine(hub, KEY_A, { ...MACHINE_A, machineKey: 'machine-bravo' });
    expect(second.status).toBe(403);
    // ...and no key may claim a machine another key already identifies.
    const takeover = await postMachine(hub, KEY_B, MACHINE_A);
    expect(takeover.status).toBe(403);
    expect((await machinesOf(hub, KEY_A)).map((machine) => machine.machineKey)).toEqual([
      'machine-alpha',
    ]);
    expect((await machinesOf(hub, KEY_B)).map((machine) => machine.machineKey)).toEqual([
      'machine-bravo',
    ]);
  });

  it('re-registers the same machine to the same id', async () => {
    const hub = await serve();
    const first = await postMachine(hub, KEY_A, MACHINE_A);
    expect(first.status).toBe(200);
    const second = await postMachine(hub, KEY_A, {
      ...MACHINE_A,
      hostname: 'alpha-host-renamed',
    });
    expect(second.status).toBe(200);
    expect(second.machineId).toBe(first.machineId);
    expect(await onlyMachineOf(hub, KEY_A)).toMatchObject({
      id: first.machineId,
      hostname: 'alpha-host-renamed',
    });
  });

  it('keeps the binding and the registration across a restart on the same database', async () => {
    const before = await serve();
    const registered = await postMachine(before, KEY_A, MACHINE_A);
    expect(registered.status).toBe(200);
    const original = await onlyMachineOf(before, KEY_A);
    await before.close();

    const after = await serve();
    const reopened = await onlyMachineOf(after, KEY_A);
    expect(reopened.id).toBe(original.id);
    expect(reopened.firstSeenAt).toBe(original.firstSeenAt);
    expect(reopened.hostname).toBe('alpha-host');

    const again = await postMachine(after, KEY_A, MACHINE_A);
    expect(again.machineId).toBe(original.id);

    // The binding survives the restart: this key still identifies one machine.
    const refused = await postMachine(after, KEY_A, { ...MACHINE_A, machineKey: 'machine-bravo' });
    expect(refused.status).toBe(403);
  });

  it('carries no key, body or message in logs or error responses', async () => {
    const hub = await serve();
    await postMachine(hub, KEY_A, MACHINE_A);
    const refused = await fetch(`${hub.url}/v1/machines`, {
      method: 'POST',
      headers: auth(WRONG_KEY),
      body: JSON.stringify({ ...MACHINE_A, content: 'a message body' }),
    });
    const forbidden = await postMachine(hub, KEY_A, { ...MACHINE_A, machineKey: 'machine-bravo' });
    expect(forbidden.status).toBe(403);
    const detail = await refused.text();

    const transcript = [...logs, detail].join('\n');
    for (const secret of [
      KEY_A,
      KEY_B,
      WRONG_KEY,
      'machine-alpha',
      'alpha-host',
      'a message body',
    ]) {
      expect(transcript).not.toContain(secret);
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).toMatch(/^(GET|POST) \/v1\/\S+ \d{3}$/u);
  });

  it('reads the key file without writing it or anything beside it', async () => {
    const before = readFileSync(keyFile, 'utf8');
    const hub = await serve();
    await postMachine(hub, KEY_A, MACHINE_A);
    await fetch(`${hub.url}/v1/machines`);
    expect(readFileSync(keyFile, 'utf8')).toBe(before);
    const extras = readdirSync(dir).filter(
      (name) => name !== 'hub-keys.json' && !name.startsWith('hub.db'),
    );
    expect(extras).toEqual([]);
  });

  it('fails fast for a missing or invalid key file, and never creates one', async () => {
    const missing = join(dir, 'absent-keys.json');
    const missingMessage = await failureOf(
      runHubServe({ port: 0, db: dbPath, keyFile: missing }, { env: {}, log }),
    );
    expect(missingMessage).toContain(missing);
    expect(existsSync(missing)).toBe(false);

    const malformed = join(dir, 'malformed-keys.json');
    writeFileSync(malformed, `${JSON.stringify({ machines: [{ key: 'short-secret' }] })}\n`);
    const malformedMessage = await failureOf(
      runHubServe({ port: 0, db: dbPath, keyFile: malformed }, { env: {}, log }),
    );
    expect(malformedMessage).toContain(malformed);
    expect(malformedMessage).not.toContain('short-secret');

    const unparseable = join(dir, 'unparseable-keys.json');
    writeFileSync(unparseable, 'not json');
    const unparseableMessage = await failureOf(
      runHubServe({ port: 0, db: dbPath, keyFile: unparseable }, { env: {}, log }),
    );
    expect(unparseableMessage).toContain('is not valid JSON');

    const duplicated = join(dir, 'duplicated-keys.json');
    writeFileSync(
      duplicated,
      `${JSON.stringify({ machines: [{ key: KEY_A }, { key: KEY_A }] }, null, 2)}\n`,
    );
    const duplicatedMessage = await failureOf(
      runHubServe({ port: 0, db: dbPath, keyFile: duplicated }, { env: {}, log }),
    );
    expect(duplicatedMessage).toContain('lists one key twice');
    expect(duplicatedMessage).not.toContain(KEY_A);
  });

  it('binds loopback only', async () => {
    const hub = await serve();
    expect(hub.host).toBe('127.0.0.1');
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);

    // The same port answers on no other address: 127.0.0.1 alone is bound.
    const elsewhere = await fetch(`http://[::1]:${String(hub.port)}/v1/meta`, {
      signal: AbortSignal.timeout(2_000),
    }).then(
      (response) => String(response.status),
      () => 'unreachable',
    );
    expect(elsewhere).toBe('unreachable');
  });

  it('records the registration in the SQLite file it was given', async () => {
    const hub = await serve();
    expect(await checkKey(hub.url, KEY_A)).toBe('ok');
    const registered = await postMachine(hub, KEY_B, MACHINE_B);
    expect(registered.status).toBe(200);

    const reopened = openHubStore(dbPath);
    try {
      expect(reopened.machines.findByKey(keyFingerprint(KEY_B))).toMatchObject({
        machineKey: 'machine-bravo',
        hostname: 'bravo-host',
      });
      expect(reopened.machines.findByKey(keyFingerprint(WRONG_KEY))).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});
