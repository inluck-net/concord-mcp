import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { openDatabase, type ConcordDatabase } from '../db/index.js';

/**
 * Hub-owned state, applied on top of the shared Concord schema when the hub
 * opens its database. The shared migration list in `src/db/schema.ts` is
 * append-only and knows nothing of the hub, so these tables are created
 * idempotently and a hub store can be the same SQLite file as a workspace
 * store. Messages and workflow state stay in the shared repositories.
 */

const HUB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hub_machines (
    id              TEXT PRIMARY KEY,
    machine_key     TEXT NOT NULL UNIQUE,
    key_fingerprint TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    hostname        TEXT NOT NULL,
    platform        TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    first_seen      TEXT NOT NULL,
    last_seen       TEXT NOT NULL
  );
`;

export interface HubMachineRecord {
  readonly id: string;
  readonly machineKey: string;
  readonly name: string;
  readonly hostname: string;
  readonly platform: string;
  readonly runtimeVersion: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** What a machine reports about itself when it registers. */
export interface NewHubMachine {
  readonly machineKey: string;
  readonly name: string;
  readonly hostname: string;
  readonly platform: string;
  readonly runtimeVersion: string;
}

export type HubRegistration =
  | { readonly outcome: 'registered'; readonly machine: HubMachineRecord }
  /** This key already identifies a different machine. */
  | { readonly outcome: 'key-bound-elsewhere' }
  /** This machine is already identified by a different key. */
  | { readonly outcome: 'machine-bound-elsewhere' };

export interface HubMachineRepository {
  /**
   * Binds this key to this machine, or reports which binding is in the way.
   * Idempotent per key and per machine: re-registering refreshes the reported
   * metadata and keeps the id.
   */
  register(machine: NewHubMachine, keyFingerprint: string): HubRegistration;
  /** The machine this key identifies, if one has registered. */
  findByKey(keyFingerprint: string): HubMachineRecord | undefined;
}

export interface HubStore {
  readonly db: ConcordDatabase;
  readonly machines: HubMachineRepository;
  close(): void;
}

const hubMachineRowSchema = z.object({
  id: z.string(),
  machine_key: z.string(),
  key_fingerprint: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  runtime_version: z.string(),
  first_seen: z.string(),
  last_seen: z.string(),
});

function parseHubMachineRow(raw: unknown): HubMachineRecord {
  const row = hubMachineRowSchema.parse(raw);
  return {
    id: row.id,
    machineKey: row.machine_key,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    runtimeVersion: row.runtime_version,
    firstSeenAt: row.first_seen,
    lastSeenAt: row.last_seen,
  };
}

export function createHubMachineRepository(db: ConcordDatabase): HubMachineRepository {
  const byKeyStmt = db.prepare('SELECT * FROM hub_machines WHERE key_fingerprint = ?');
  const byMachineStmt = db.prepare('SELECT * FROM hub_machines WHERE machine_key = ?');
  const insertStmt = db.prepare(`
    INSERT INTO hub_machines (
      id, machine_key, key_fingerprint, name, hostname, platform, runtime_version,
      first_seen, last_seen
    ) VALUES (
      @id, @machine_key, @key_fingerprint, @name, @hostname, @platform, @runtime_version,
      @now, @now
    )
  `);
  const refreshStmt = db.prepare(`
    UPDATE hub_machines SET
      name = @name,
      hostname = @hostname,
      platform = @platform,
      runtime_version = @runtime_version,
      last_seen = @now
    WHERE id = @id
  `);

  function findByKey(keyFingerprint: string): HubMachineRecord | undefined {
    const raw: unknown = byKeyStmt.get(keyFingerprint);
    return raw === undefined ? undefined : parseHubMachineRow(raw);
  }

  function findByMachineKey(machineKey: string): HubMachineRecord | undefined {
    const raw: unknown = byMachineStmt.get(machineKey);
    return raw === undefined ? undefined : parseHubMachineRow(raw);
  }

  function readBack(machineKey: string): HubMachineRecord {
    const stored = findByMachineKey(machineKey);
    if (stored === undefined) {
      throw new Error('Machine registration could not be read back.');
    }
    return stored;
  }

  return {
    findByKey,
    register(machine, keyFingerprint) {
      const now = new Date().toISOString();
      const boundToKey = findByKey(keyFingerprint);
      if (boundToKey !== undefined) {
        if (boundToKey.machineKey !== machine.machineKey) {
          return { outcome: 'key-bound-elsewhere' };
        }
        refreshStmt.run({
          id: boundToKey.id,
          name: machine.name,
          hostname: machine.hostname,
          platform: machine.platform,
          runtime_version: machine.runtimeVersion,
          now,
        });
        return { outcome: 'registered', machine: readBack(machine.machineKey) };
      }
      if (findByMachineKey(machine.machineKey) !== undefined) {
        return { outcome: 'machine-bound-elsewhere' };
      }
      insertStmt.run({
        id: randomUUID(),
        machine_key: machine.machineKey,
        key_fingerprint: keyFingerprint,
        name: machine.name,
        hostname: machine.hostname,
        platform: machine.platform,
        runtime_version: machine.runtimeVersion,
        now,
      });
      return { outcome: 'registered', machine: readBack(machine.machineKey) };
    },
  };
}

/** Open the hub's SQLite file and create the hub-owned tables beside the shared ones. */
export function openHubStore(filename: string): HubStore {
  const db = openDatabase(filename);
  db.exec(HUB_SCHEMA);
  let closed = false;
  return {
    db,
    machines: createHubMachineRepository(db),
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
