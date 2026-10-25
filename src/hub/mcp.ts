import type { IncomingMessage, ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { LOCAL_PROJECT } from '../db/index.js';
import type { AgentIdentity } from '../domain/identity.js';
import { createServer } from '../server.js';
import { forbidden, type HubOutcome } from './outcome.js';
import type { HubMachineRecord, HubStore } from './store.js';

/**
 * The SDK's Streamable HTTP server transport, as a `Transport`: delegation
 * rather than a cast, exactly as `cloud/http-transport.ts` does it — the SDK
 * types its handler properties as possibly undefined, which
 * `exactOptionalPropertyTypes` will not accept for `onclose?: () => void`.
 */
class HubHttpTransport implements Transport {
  readonly #inner: StreamableHTTPServerTransport;

  onclose: NonNullable<Transport['onclose']> = () => undefined;
  onerror: NonNullable<Transport['onerror']> = () => undefined;
  onmessage: NonNullable<Transport['onmessage']> = () => undefined;

  constructor() {
    // Stateless: no session id, so each request is answered by its own
    // transport and one machine's session is never another's.
    this.#inner = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  }

  start(): Promise<void> {
    this.#inner.onclose = () => {
      this.onclose();
    };
    this.#inner.onerror = (error) => {
      this.onerror(error);
    };
    this.#inner.onmessage = (message, extra) => {
      this.onmessage(message, extra);
    };
    return this.#inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.#inner.send(message, options);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  handleRequest(request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> {
    return this.#inner.handleRequest(request, response, body);
  }
}

/**
 * `/mcp`: the five workflow tools over Streamable HTTP, every call routed to
 * the handlers `src/server.ts` registers locally. The actor is chosen by the
 * hub — the authenticated machine plus an agent it has registered — before any
 * handler runs, so a model-supplied `agent_id` can never act for an agent on
 * another machine, and `inspect_work` sees a verified viewer so message content
 * follows `docs/messaging-v2.md`.
 */

/** A `tools/call` message, as far as the actor question is concerned. */
const toolCallSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.json()).optional(),
  }),
});

interface NamedAgent {
  readonly agentId: string;
  readonly kind: string | undefined;
  readonly tool: string;
  /** Whether `agent_id` names the reader (a message or task selector is present). */
  readonly readerScope: boolean;
}

export type McpActor = { readonly identity: AgentIdentity | undefined } | HubOutcome;

function namedAgent(message: unknown): NamedAgent | undefined {
  const parsed = toolCallSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const args = parsed.data.params.arguments ?? {};
  const value = args['agent_id'];
  if (typeof value !== 'string' || value === '') return undefined;
  const kind = args['kind'];
  const selector = (name: string): boolean => {
    const chosen = args[name];
    return typeof chosen === 'string' && chosen !== '';
  };
  return {
    agentId: value,
    kind: typeof kind === 'string' && kind !== '' ? kind : undefined,
    tool: parsed.data.params.name,
    readerScope: selector('message_id') || selector('task_id'),
  };
}

/**
 * Who a JSON-RPC body speaks for, or the refusal. An agent bound to another
 * machine may never act — and `inspect_work` naming one as its subject gets
 * the presence-only view `docs/messaging-v2.md` prescribes, never its mail. An
 * unbound agent is bound by `start_work` (the call that registers an agent)
 * and refused everywhere else.
 */
export function resolveMcpActor(
  store: HubStore,
  machine: HubMachineRecord,
  body: unknown,
): McpActor {
  const named = (Array.isArray(body) ? body : [body])
    .map(namedAgent)
    .filter((entry): entry is NamedAgent => entry !== undefined);
  const speakers = [...new Set(named.map((entry) => entry.agentId))];
  if (speakers.length > 1) return forbidden('one request speaks for one agent');
  const speaker = named[0];
  if (speaker === undefined) return { identity: undefined };

  const existing = store.agents.find(speaker.agentId);
  // `inspect_work` with no message or task names an inbox to look at, not an
  // agent to be: another machine's agent is presence only, as v2 requires.
  if (
    speaker.tool === 'inspect_work' &&
    !speaker.readerScope &&
    existing !== undefined &&
    existing.machineId !== machine.id
  ) {
    return { identity: { agentId: machine.id, kind: machine.name, origin: 'session' } };
  }
  if (existing !== undefined && existing.machineId !== machine.id) {
    return forbidden('this agent belongs to another machine');
  }
  if (existing !== undefined) {
    return { identity: { agentId: existing.id, kind: existing.kind, origin: 'session' } };
  }
  if (speaker.tool !== 'start_work') {
    return forbidden('this agent is not registered on this machine');
  }
  const bound = store.agents.register(machine.id, {
    agentKey: speaker.agentId,
    kind: speaker.kind ?? 'unknown',
    pid: null,
    cwd: null,
  });
  if (bound.outcome === 'bound-elsewhere') {
    return forbidden('this agent is already registered on another machine');
  }
  return { identity: { agentId: bound.agent.id, kind: bound.agent.kind, origin: 'session' } };
}

/** The project scope a request names, or the hub's default. */
export function projectOf(request: IncomingMessage): string {
  const header = request.headers['x-concord-project'];
  const named = Array.isArray(header) ? header[0] : header;
  const project = named?.trim();
  return project === undefined || project === '' ? LOCAL_PROJECT : project;
}

/**
 * One `/mcp` request: a fresh server over the project's repositories and a
 * stateless transport, so no request sees another's session. The response is
 * written by the transport; the caller reads its status afterwards.
 */
export async function serveMcp(
  store: HubStore,
  project: string,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  identity: AgentIdentity | undefined,
): Promise<void> {
  const server = createServer(store.reposFor(project), {
    ...(identity === undefined ? {} : { identity }),
  });
  const transport = new HubHttpTransport();
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await server.close();
  }
}
