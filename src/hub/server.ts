import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import {
  deleteReceiver,
  getAgent,
  listAgents,
  putEndpoint,
  putReceiver,
  registerAgent,
} from './agents.js';
import { authenticate, type HubKeyFile, type HubKeyIdentity } from './keys.js';
import { drainMessages, getReceipt, reportFailure, sendMessage } from './messages.js';
import { hubMeta } from './meta.js';
import { badRequest, forbidden, notFound, payloadTooLarge, type HubOutcome } from './outcome.js';
import type { HubStore, NewHubMachine } from './store.js';

/**
 * The private hub's HTTP surface: the Concord Cloud client protocol, served
 * from this machine. It binds loopback only — remote access is Tailscale
 * Serve's job — authenticates every state call with a machine key, and logs
 * one line per request naming method, path and status, never a header, a body
 * or a key.
 */

/** The only address the hub binds. */
export const HUB_BIND_HOST = '127.0.0.1';

/** One request's body: enough for a registration, never unbounded. */
const MAX_BODY_BYTES = 64 * 1024;

/** The machine registration body `registerMachine` sends; the client is the contract. */
const registrationSchema = z.object({
  machineKey: z.string().min(1),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  runtimeVersion: z.string(),
});

export interface HubServerOptions {
  /** 0 binds an ephemeral port, as tests do. */
  readonly port: number;
  readonly keys: HubKeyFile;
  /** The hub owns this store and closes it when the listener closes. */
  readonly store: HubStore;
  /** One line per request: method, path, status — never headers or bodies. */
  readonly log?: (line: string) => void;
}

export interface HubServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function startHub(options: HubServerOptions): Promise<HubServer> {
  const log = options.log ?? ((): void => undefined);
  const server = createServer((request, response) => {
    void route(request, response, options).then(
      ({ method, path, status }) => {
        log(`${method} ${path} ${String(status)}`);
      },
      () => {
        log('request failed');
        if (!response.headersSent) {
          sendJson(response, 500, { error: 'internal error' });
        }
      },
    );
  });
  return new Promise((resolve, reject) => {
    const refuse = (error: Error): void => {
      reject(error);
    };
    server.once('error', refuse);
    server.listen(options.port, HUB_BIND_HOST, () => {
      server.removeListener('error', refuse);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('The hub could not bind a loopback port.'));
        return;
      }
      let closed = false;
      resolve({
        host: HUB_BIND_HOST,
        port: address.port,
        url: `http://${HUB_BIND_HOST}:${String(address.port)}`,
        close: async () => {
          if (closed) return;
          closed = true;
          await closeListener(server);
          options.store.close();
        },
      });
    });
  });
}

function closeListener(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    .end(JSON.stringify(body));
}

/** The bearer secret, or undefined when the request carries none. */
function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  return /^Bearer\s+(.+)$/isu.exec(header.trim())?.[1];
}

type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly outcome: HubOutcome };

async function readJsonBody(request: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > MAX_BODY_BYTES) return { ok: false, outcome: payloadTooLarge() };
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, outcome: badRequest('bad request') };
  }
  try {
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: true, value: raw };
  } catch {
    return { ok: false, outcome: badRequest('bad request') };
  }
}

interface Answered {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

function answer(
  response: ServerResponse,
  method: string,
  path: string,
  outcome: HubOutcome,
): Answered {
  sendJson(response, outcome.status, outcome.body);
  return { method, path, status: outcome.status };
}

/** The single path segment a route names its agent or message with. */
function segment(match: RegExpExecArray): string {
  return match[1] ?? '';
}

const AGENT_ENDPOINT = /^\/v1\/agents\/([^/]+)\/endpoint$/u;
const AGENT_RECEIVER = /^\/v1\/agents\/([^/]+)\/endpoint\/receiver$/u;
const AGENT_ONE = /^\/v1\/agents\/([^/]+)$/u;
const MESSAGE_FAILURE = /^\/v1\/messages\/([^/]+)\/failure$/u;
const MESSAGE_ONE = /^\/v1\/messages\/([^/]+)$/u;

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HubServerOptions,
): Promise<Answered> {
  const method = request.method ?? 'GET';
  const path = new URL(request.url ?? '/', `http://${HUB_BIND_HOST}`).pathname;

  // Public: the client reads it before it will trust a key.
  if (method === 'GET' && path === '/v1/meta') {
    return answer(response, method, path, { status: 200, body: hubMeta() });
  }

  const bearer = bearerOf(request);
  const identity = bearer === undefined ? undefined : authenticate(options.keys, bearer);
  if (identity === undefined) {
    return answer(response, method, path, { status: 401, body: { error: 'unauthorized' } });
  }

  const machine = options.store.machines.findByKey(identity.fingerprint);
  if (method === 'GET' && path === '/v1/machines') {
    return answer(response, method, path, {
      status: 200,
      body: { machines: machine === undefined ? [] : [machine] },
    });
  }
  if (method === 'POST' && path === '/v1/machines') {
    return withBody(request, response, method, path, (body) =>
      registerMachine(options.store, identity, body),
    );
  }

  // Everything below is state: a key that has not registered its machine has
  // none here, and the cloud refuses calls naming a machine it has not seen.
  if (machine === undefined) {
    return answer(response, method, path, forbidden('this key has not registered its machine'));
  }
  const store = options.store;

  if (method === 'GET' && path === '/v1/agents') {
    return answer(response, method, path, listAgents(store));
  }
  if (method === 'POST' && path === '/v1/agents') {
    return withBody(request, response, method, path, (body) => registerAgent(store, machine, body));
  }

  const receiver = AGENT_RECEIVER.exec(path);
  if (receiver !== null) {
    const agentId = segment(receiver);
    if (method === 'PUT') {
      return withBody(request, response, method, path, (body) =>
        putReceiver(store, machine, agentId, body),
      );
    }
    if (method === 'DELETE') {
      return answer(response, method, path, deleteReceiver(store, machine, agentId));
    }
  }
  const endpoint = AGENT_ENDPOINT.exec(path);
  if (endpoint !== null && method === 'PUT') {
    return withBody(request, response, method, path, (body) =>
      putEndpoint(store, machine, segment(endpoint), body),
    );
  }
  const agent = AGENT_ONE.exec(path);
  if (agent !== null && method === 'GET') {
    return answer(response, method, path, getAgent(store, machine, segment(agent)));
  }

  if (method === 'POST' && path === '/v1/messages') {
    return withBody(request, response, method, path, (body) => sendMessage(store, machine, body));
  }
  if (method === 'POST' && path === '/v1/messages/drain') {
    return withBody(request, response, method, path, (body) => drainMessages(store, machine, body));
  }
  const failure = MESSAGE_FAILURE.exec(path);
  if (failure !== null && method === 'POST') {
    return withBody(request, response, method, path, (body) =>
      reportFailure(store, machine, segment(failure), body),
    );
  }
  const message = MESSAGE_ONE.exec(path);
  if (message !== null && method === 'GET') {
    return answer(response, method, path, getReceipt(store, machine, segment(message)));
  }

  return answer(response, method, path, notFound());
}

async function withBody(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  handle: (body: unknown) => HubOutcome | Promise<HubOutcome>,
): Promise<Answered> {
  const body = await readJsonBody(request);
  if (!body.ok) return answer(response, method, path, body.outcome);
  return answer(response, method, path, await handle(body.value));
}

function registerMachine(store: HubStore, identity: HubKeyIdentity, body: unknown): HubOutcome {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) return badRequest('bad request');
  // The key file names the machine when it has a label; the body's own name is
  // the fallback. Either way the key decides which machine this may be.
  const machine: NewHubMachine = {
    machineKey: parsed.data.machineKey,
    name: identity.name ?? parsed.data.name,
    hostname: parsed.data.hostname,
    platform: parsed.data.platform,
    runtimeVersion: parsed.data.runtimeVersion,
  };
  const registration = store.machines.register(machine, identity.fingerprint);
  if (registration.outcome === 'key-bound-elsewhere') {
    return forbidden('this key already identifies another machine');
  }
  if (registration.outcome === 'machine-bound-elsewhere') {
    return forbidden('this machine is already identified by another key');
  }
  return { status: 200, body: { machine: registration.machine } };
}
