import { z } from 'zod';

import { MAX_WAIT_SECONDS } from '../cloud/runtime.js';
import { agentMessageErrorCodeValues, type AgentMessageRecord } from '../db/rows.js';
import { toReceipt } from '../domain/receipts.js';
import { AgentMessageDeliveryError, handleSendAgentMessage } from '../tools/agent-messages.js';
import { ownAgent, PULL_ENDPOINT_TTL_MS } from './agents.js';
import { badRequest, conflict, forbidden, notFound, ok, type HubOutcome } from './outcome.js';
import type { HubMachineRecord, HubStore } from './store.js';

/**
 * Messages over the hub: the same lifecycle as a local store — `create`,
 * `claimPendingForRecipient`, `markReplied`, `markFailed`, and the receipt view
 * of `domain/receipts.ts` — addressed over HTTP. A drain key names one batch:
 * a retry with it replays that batch, from SQLite, including after a restart.
 */

/** How often a waiting drain looks for something to take. */
const DRAIN_POLL_MS = 50;

/** `POST /v1/messages`, matching `SendAgentMessageInput`. */
const sendSchema = z.object({
  operation: z.enum(['prompt', 'reply']),
  agentId: z.string().min(1),
  toAgentId: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  content: z.string(),
  idempotencyKey: z.string().min(1),
});

/** `POST /v1/messages/drain`, matching the body `drainCloud` sends. */
const drainSchema = z.object({
  agentId: z.string().min(1),
  drainKey: z.string().min(1),
  waitSeconds: z.number().int().min(0).optional(),
});

/** `POST /v1/messages/:id/failure`, matching the body `reportDeliveryFailure` sends. */
const failureSchema = z.object({
  agentId: z.string().min(1),
  errorCode: z.enum(agentMessageErrorCodeValues),
  errorDetail: z.string(),
});

/** A message as `drainCloud` parses it: keys and task key, never an internal row. */
function toCloudMessage(message: AgentMessageRecord): object {
  return {
    id: message.messageId,
    senderAgentKey: message.senderAgentId,
    taskKey: message.taskId,
    replyToMessageId: message.replyToMessageId,
    content: message.content,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt,
  };
}

/**
 * A refused send: the codes `handleSendAgentMessage` raises, as statuses. Its
 * messages name agents, messages and fields — never content, never a key.
 */
function refusedSend(error: AgentMessageDeliveryError): HubOutcome {
  switch (error.code) {
    case 'unauthorized':
      return forbidden(error.message);
    case 'target_unreachable':
      return notFound(error.message);
    default:
      return conflict(error.message);
  }
}

export function sendMessage(store: HubStore, machine: HubMachineRecord, body: unknown): HubOutcome {
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  const sender = ownAgent(store, machine, parsed.data.agentId);
  if ('status' in sender) return sender;
  if (parsed.data.operation === 'prompt' && parsed.data.toAgentId === undefined) {
    return badRequest('to_agent_id is required for a prompt');
  }
  if (parsed.data.operation === 'reply' && parsed.data.replyToMessageId === undefined) {
    return badRequest('reply_to_message_id is required for a reply');
  }
  try {
    const result = handleSendAgentMessage(store.repos, {
      operation: parsed.data.operation,
      agentId: sender.agent.id,
      toAgentId: parsed.data.toAgentId,
      replyToMessageId: parsed.data.replyToMessageId,
      taskId: parsed.data.taskId,
      content: parsed.data.content,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return ok({
      message: toCloudMessage(result.message),
      receipt: toReceipt(result.message),
      idempotentReplay: result.idempotentReplay,
      delivery: result.delivery,
      outlook: result.outlook,
    });
  } catch (error) {
    if (error instanceof AgentMessageDeliveryError) return refusedSend(error);
    // The remaining failures name a missing task or field, by name.
    return badRequest(error instanceof Error ? error.message : 'bad request');
  }
}

/** One drain's result: a batch it must answer with, or nothing this round. */
type DrainBatch =
  | { readonly kind: 'batch'; readonly messages: readonly AgentMessageRecord[] }
  | { readonly kind: 'waiting' };

function messagesOf(store: HubStore, ids: readonly string[]): AgentMessageRecord[] {
  return ids.flatMap((id) => {
    const message = store.repos.agentMessages.get(id);
    return message === undefined ? [] : [message];
  });
}

/**
 * One drain's batch: the one this key already delivered, or every message
 * waiting, claimed and remembered under the key in the same transaction. A
 * claim is the recipient's delivery (✓✓); nothing here is ever read.
 */
function takeBatch(store: HubStore, agentId: string, drainKey: string): DrainBatch {
  const provider = store.repos.agentEndpoints.getByAgent(agentId)?.provider ?? 'pull';
  const claim = (): DrainBatch => {
    const replay = store.drains.replay(agentId, drainKey);
    if (replay !== undefined) {
      return { kind: 'batch', messages: messagesOf(store, replay) };
    }
    const claimed = store.repos.agentMessages.claimPendingForRecipient(agentId, provider, {
      session: null,
      via: 'hook',
    });
    if (claimed.length === 0) return { kind: 'waiting' };
    const ids = store.drains.record(
      agentId,
      drainKey,
      claimed.map((message) => message.messageId),
    );
    return { kind: 'batch', messages: messagesOf(store, ids) };
  };
  // Immediate: the claim is a write, and a deferred transaction could read an
  // old snapshot and lose the upgrade (see the note in the message repository).
  return store.db.transaction(claim).immediate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export async function drainMessages(
  store: HubStore,
  machine: HubMachineRecord,
  body: unknown,
): Promise<HubOutcome> {
  const parsed = drainSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  const owned = ownAgent(store, machine, parsed.data.agentId);
  if ('status' in owned) return owned;
  const agentId = owned.agent.id;
  // The session is doing the hub's work: it is present, and stays promptable.
  store.repos.agents.touch(agentId);
  const endpoint = store.repos.agentEndpoints.getByAgent(agentId);
  if (endpoint !== undefined) {
    store.repos.agentEndpoints.heartbeat(
      endpoint.endpointId,
      new Date(Date.now() + PULL_ENDPOINT_TTL_MS).toISOString(),
    );
  }
  const wait = Math.min(parsed.data.waitSeconds ?? 0, MAX_WAIT_SECONDS);
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    // A key that already delivered a batch answers with it at once — the same
    // batch, so a retry of a lost answer never waits and never duplicates.
    const batch = takeBatch(store, agentId, parsed.data.drainKey);
    if (batch.kind === 'batch') {
      return ok({ messages: batch.messages.map(toCloudMessage) });
    }
    if (Date.now() >= deadline) return ok({ messages: [] });
    await sleep(Math.min(DRAIN_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

export function getReceipt(
  store: HubStore,
  machine: HubMachineRecord,
  messageId: string,
): HubOutcome {
  const message = store.repos.agentMessages.get(messageId);
  if (message === undefined) return notFound('no such message');
  const participant =
    store.agents.ownedBy(machine.id, message.senderAgentId) !== undefined ||
    store.agents.ownedBy(machine.id, message.recipientAgentId) !== undefined;
  // Not a participant: the same answer as a message that is not there.
  if (!participant) return notFound('no such message');
  // Expiry is lazy, and applied before any receipt is shown.
  store.repos.agentMessages.sweepStale();
  const current = store.repos.agentMessages.get(messageId) ?? message;
  return ok({ receipt: toReceipt(current) });
}

export function reportFailure(
  store: HubStore,
  machine: HubMachineRecord,
  messageId: string,
  body: unknown,
): HubOutcome {
  const parsed = failureSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  const owned = ownAgent(store, machine, parsed.data.agentId);
  if ('status' in owned) return owned;
  const message = store.repos.agentMessages.get(messageId);
  if (message === undefined) return notFound('no such message');
  if (message.recipientAgentId !== owned.agent.id) {
    return forbidden('only the recipient can report a delivery failure');
  }
  // `failed` is reachable from `sent`; a message that reached its recipient has
  // moved on, and the client reads the refusal as final.
  if (message.status !== 'sent' && message.status !== 'failed') {
    return conflict('this message has already been delivered');
  }
  store.repos.agentMessages.markFailed(messageId, parsed.data.errorCode, parsed.data.errorDetail);
  return ok({});
}
