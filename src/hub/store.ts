import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  createRepositories,
  openDatabase,
  type AgentRepository,
  type ConcordDatabase,
  type Repositories,
} from '../db/index.js';
import { MESSAGE_TTL_MS } from '../db/rows.js';

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

  CREATE TABLE IF NOT EXISTS hub_agents (
    agent_id   TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL REFERENCES hub_machines(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hub_drains (
    agent_id    TEXT NOT NULL,
    drain_key   TEXT NOT NULL,
    message_ids TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (agent_id, drain_key)
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

export interface HubAgentView {
  readonly id: string;
  readonly agentKey: string;
  readonly machineId: string;
  readonly kind: string;
  readonly summary: string | null;
  readonly status: string;
  readonly lastSeenAt: string;
}

/** What a machine reports about one of its agent sessions. */
export interface NewHubAgent {
  readonly agentKey: string;
  readonly kind: string;
  readonly pid: number | null;
  readonly cwd: string | null;
}

export type HubAgentRegistration =
  | { readonly outcome: 'registered'; readonly agent: HubAgentView }
  /** This agent is already registered on another machine. */
  | { readonly outcome: 'bound-elsewhere' };

export interface HubAgentRepository {
  /**
   * Binds this agent to this machine and refreshes its presence row. The agent
   * id is the session-derived key it registers with, so every channel addresses
   * the same agent by the same id (see `domain/identity.ts`).
   */
  register(machineId: string, agent: NewHubAgent): HubAgentRegistration;
  /** The agent, when it is registered; `machineId` picks whose, if anyone's. */
  find(agentId: string): HubAgentView | undefined;
  /** The agent only when this machine owns it. */
  ownedBy(machineId: string, agentId: string): HubAgentView | undefined;
  /** Every registered agent, across machines: the presence roster. */
  list(): HubAgentView[];
}

export interface HubDrainRepository {
  /** The batch this key already delivered, or undefined when the key is new. */
  replay(agentId: string, drainKey: string): string[] | undefined;
  /**
   * Remember a claimed batch under this key, and return the batch that stands:
   * the one recorded first wins if two claim under one key at once.
   */
  record(agentId: string, drainKey: string, messageIds: readonly string[]): string[];
}

export interface HubStore {
  readonly db: ConcordDatabase;
  /** The shared Concord repositories: messages and workflow state live here. */
  readonly repos: Repositories;
  readonly machines: HubMachineRepository;
  readonly agents: HubAgentRepository;
  readonly drains: HubDrainRepository;
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

const hubAgentRowSchema = z.object({
  agent_id: z.string(),
  machine_id: z.string(),
});

/**
 * An agent's presence row in the shared registry. Re-registering refreshes the
 * session's own facts (kind, pid, cwd) and leaves work state (`owner`, `summary`,
 * `status`, …) alone, as `ensureAgentRegistered` does.
 */
function refreshPresence(agents: AgentRepository, agent: NewHubAgent): void {
  const existing = agents.get(agent.agentKey);
  agents.upsert({
    agentId: agent.agentKey,
    kind: agent.kind,
    owner: existing?.owner ?? null,
    model: existing?.model ?? null,
    pid: agent.pid,
    cwd: agent.cwd,
    worktree: existing?.worktree ?? null,
    branch: existing?.branch ?? null,
    summary: existing?.summary ?? null,
    status: existing?.status ?? 'active',
  });
}

export function createHubAgentRepository(
  db: ConcordDatabase,
  agents: AgentRepository,
): HubAgentRepository {
  const byIdStmt = db.prepare('SELECT * FROM hub_agents WHERE agent_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO hub_agents (agent_id, machine_id, created_at)
    VALUES (@agent_id, @machine_id, @now)
  `);
  const listStmt = db.prepare('SELECT * FROM hub_agents ORDER BY created_at, agent_id');

  function viewOf(agentId: string, machineId: string): HubAgentView | undefined {
    const stored = agents.get(agentId);
    if (stored === undefined) return undefined;
    return {
      id: agentId,
      agentKey: agentId,
      machineId,
      kind: stored.kind,
      summary: stored.summary,
      status: stored.status,
      lastSeenAt: stored.lastSeen,
    };
  }

  function find(agentId: string): HubAgentView | undefined {
    const raw: unknown = byIdStmt.get(agentId);
    if (raw === undefined) return undefined;
    const row = hubAgentRowSchema.parse(raw);
    return viewOf(row.agent_id, row.machine_id);
  }

  return {
    find,
    ownedBy(machineId, agentId) {
      const agent = find(agentId);
      return agent?.machineId === machineId ? agent : undefined;
    },
    list() {
      const raw: unknown = listStmt.all();
      return z
        .array(hubAgentRowSchema)
        .parse(raw)
        .flatMap((row) => {
          const agent = find(row.agent_id);
          return agent === undefined ? [] : [agent];
        });
    },
    register(machineId, agent) {
      const existing = find(agent.agentKey);
      if (existing !== undefined && existing.machineId !== machineId) {
        return { outcome: 'bound-elsewhere' };
      }
      if (existing === undefined) {
        insertStmt.run({
          agent_id: agent.agentKey,
          machine_id: machineId,
          now: new Date().toISOString(),
        });
      }
      refreshPresence(agents, agent);
      const registered = viewOf(agent.agentKey, machineId);
      if (registered === undefined) {
        throw new Error('Agent registration could not be read back.');
      }
      return { outcome: 'registered', agent: registered };
    },
  };
}

const drainRowSchema = z.object({
  message_ids: z.string(),
});

export function createHubDrainRepository(db: ConcordDatabase): HubDrainRepository {
  const replayStmt = db.prepare(
    'SELECT message_ids FROM hub_drains WHERE agent_id = ? AND drain_key = ?',
  );
  const recordStmt = db.prepare(`
    INSERT OR IGNORE INTO hub_drains (agent_id, drain_key, message_ids, created_at)
    VALUES (@agent_id, @drain_key, @message_ids, @now)
  `);
  const pruneStmt = db.prepare('DELETE FROM hub_drains WHERE agent_id = ? AND created_at < ?');
  const messageIds = z.array(z.string());

  function replay(agentId: string, drainKey: string): string[] | undefined {
    const raw: unknown = replayStmt.get(agentId, drainKey);
    if (raw === undefined) return undefined;
    const parsed: unknown = JSON.parse(drainRowSchema.parse(raw).message_ids);
    return messageIds.parse(parsed);
  }

  return {
    replay,
    record(agentId, drainKey, ids) {
      const now = new Date().toISOString();
      pruneStmt.run(agentId, new Date(Date.now() - MESSAGE_TTL_MS).toISOString());
      recordStmt.run({
        agent_id: agentId,
        drain_key: drainKey,
        message_ids: JSON.stringify(ids),
        now,
      });
      return replay(agentId, drainKey) ?? [];
    },
  };
}

/** Open the hub's SQLite file and create the hub-owned tables beside the shared ones. */
export function openHubStore(filename: string): HubStore {
  const db = openDatabase(filename);
  db.exec(HUB_SCHEMA);
  const repos = createRepositories(db);
  let closed = false;
  return {
    db,
    repos,
    machines: createHubMachineRepository(db),
    agents: createHubAgentRepository(db, repos.agents),
    drains: createHubDrainRepository(db),
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
