import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { HubMachineRecord, HubStore, HubAgentView } from './store.js';
import { badRequest, conflict, forbidden, notFound, ok, type HubOutcome } from './outcome.js';

/**
 * Agent registration, presence, and the pull endpoint a session drains its
 * inbox through. Every handler acts for one authenticated machine, and only
 * ever on agents that machine owns.
 */

/** How long a registered pull endpoint stays promptable between drains. */
export const PULL_ENDPOINT_TTL_MS = 90_000;

/** `POST /v1/agents`, in the shape `registerCloudAgent` sends. */
const registrationSchema = z.object({
  agentKey: z.string().min(1),
  kind: z.string().min(1),
  machineId: z.string().min(1),
  pid: z.number().int().optional(),
  cwd: z.string().optional(),
});

/** `PUT /v1/agents/:id/endpoint`, in the shape `connectPullEndpoint` sends. */
const endpointSchema = z.object({
  provider: z.string().min(1),
  transport: z.string().min(1),
  capabilities: z.array(z.string()),
  address: z.string().min(1),
  credentialHash: z.string().min(1),
});

/** `PUT /v1/agents/:id/endpoint/receiver`, in the shape `renewReceiver` sends. */
const receiverSchema = z.object({ ttlSeconds: z.number().int().positive() });

/** The agent this machine owns, or the refusal saying which it is not. */
export function ownAgent(
  store: HubStore,
  machine: HubMachineRecord,
  agentId: string,
): { readonly agent: HubAgentView } | HubOutcome {
  const agent = store.agents.find(agentId);
  if (agent === undefined) return notFound('no such agent');
  if (agent.machineId !== machine.id) {
    return forbidden('this agent belongs to another machine');
  }
  return { agent };
}

export function registerAgent(
  store: HubStore,
  machine: HubMachineRecord,
  body: unknown,
): HubOutcome {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  if (parsed.data.machineId !== machine.id) {
    return forbidden('this key cannot register an agent on another machine');
  }
  const registration = store.agents.register(machine.id, {
    agentKey: parsed.data.agentKey,
    kind: parsed.data.kind,
    pid: parsed.data.pid ?? null,
    cwd: parsed.data.cwd ?? null,
  });
  if (registration.outcome === 'bound-elsewhere') {
    return forbidden('this agent is already registered on another machine');
  }
  return ok({ agent: registration.agent });
}

export function listAgents(store: HubStore): HubOutcome {
  return ok({ agents: store.agents.list() });
}

export function getAgent(store: HubStore, machine: HubMachineRecord, agentId: string): HubOutcome {
  const owned = ownAgent(store, machine, agentId);
  if ('status' in owned) return owned;
  return ok({ agent: owned.agent });
}

export function putEndpoint(
  store: HubStore,
  machine: HubMachineRecord,
  agentId: string,
  body: unknown,
): HubOutcome {
  const owned = ownAgent(store, machine, agentId);
  if ('status' in owned) return owned;
  const parsed = endpointSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  const existing = store.repos.agentEndpoints.getByAgent(agentId);
  store.repos.agentEndpoints.upsert({
    endpointId: existing?.endpointId ?? randomUUID(),
    agentId,
    provider: parsed.data.provider,
    transport: parsed.data.transport,
    capabilities: parsed.data.capabilities,
    address: parsed.data.address,
    credentialHash: parsed.data.credentialHash,
    status: 'connected',
    expiresAt: new Date(Date.now() + PULL_ENDPOINT_TTL_MS).toISOString(),
  });
  return ok({});
}

export function putReceiver(
  store: HubStore,
  machine: HubMachineRecord,
  agentId: string,
  body: unknown,
): HubOutcome {
  const owned = ownAgent(store, machine, agentId);
  if ('status' in owned) return owned;
  const parsed = receiverSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  const endpoint = store.repos.agentEndpoints.getByAgent(agentId);
  if (endpoint === undefined) return conflict('this agent has no endpoint');
  store.repos.agentEndpoints.heartbeatReceiver(
    endpoint.endpointId,
    new Date(Date.now() + parsed.data.ttlSeconds * 1000).toISOString(),
  );
  return ok({});
}

export function deleteReceiver(
  store: HubStore,
  machine: HubMachineRecord,
  agentId: string,
): HubOutcome {
  const owned = ownAgent(store, machine, agentId);
  if ('status' in owned) return owned;
  const endpoint = store.repos.agentEndpoints.getByAgent(agentId);
  // Releasing a lease nobody holds is the same answer: nothing left to hold.
  if (endpoint !== undefined) store.repos.agentEndpoints.clearReceiver(endpoint.endpointId);
  return ok({});
}
