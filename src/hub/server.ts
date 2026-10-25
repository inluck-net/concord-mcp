import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import { authenticate, type HubKeyFile } from './keys.js';
import { hubMeta } from './meta.js';
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

/** The registration body `registerMachine` sends; the client is the contract. */
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
  | { readonly ok: false; readonly status: 400 | 413 };

async function readJsonBody(request: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413 };
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  try {
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ok: true, value: raw };
  } catch {
    return { ok: false, status: 400 };
  }
}

interface Answered {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: HubServerOptions,
): Promise<Answered> {
  const method = request.method ?? 'GET';
  const path = new URL(request.url ?? '/', `http://${HUB_BIND_HOST}`).pathname;

  // Public: the client reads it before it will trust a key.
  if (method === 'GET' && path === '/v1/meta') {
    sendJson(response, 200, hubMeta());
    return { method, path, status: 200 };
  }

  const bearer = bearerOf(request);
  const identity = bearer === undefined ? undefined : authenticate(options.keys, bearer);
  if (identity === undefined) {
    sendJson(response, 401, { error: 'unauthorized' });
    return { method, path, status: 401 };
  }

  if (method === 'GET' && path === '/v1/machines') {
    const machine = options.store.machines.findByKey(identity.fingerprint);
    sendJson(response, 200, { machines: machine === undefined ? [] : [machine] });
    return { method, path, status: 200 };
  }

  if (method === 'POST' && path === '/v1/machines') {
    return register(request, response, options, identity, method, path);
  }

  sendJson(response, 404, { error: 'not found' });
  return { method, path, status: 404 };
}

async function register(
  request: IncomingMessage,
  response: ServerResponse,
  options: HubServerOptions,
  identity: { readonly fingerprint: string; readonly name: string | undefined },
  method: string,
  path: string,
): Promise<Answered> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    const status = body.status;
    sendJson(response, status, {
      error: status === 413 ? 'payload too large' : 'bad request',
    });
    return { method, path, status };
  }
  const parsed = registrationSchema.safeParse(body.value);
  if (!parsed.success) {
    sendJson(response, 400, { error: 'bad request' });
    return { method, path, status: 400 };
  }
  // The key file names the machine when it has a label; the body's own name is
  // the fallback. Either way the key decides which machine this may be.
  const machine: NewHubMachine = {
    machineKey: parsed.data.machineKey,
    name: identity.name ?? parsed.data.name,
    hostname: parsed.data.hostname,
    platform: parsed.data.platform,
    runtimeVersion: parsed.data.runtimeVersion,
  };
  const registration = options.store.machines.register(machine, identity.fingerprint);
  if (registration.outcome === 'key-bound-elsewhere') {
    sendJson(response, 403, { error: 'this key already identifies another machine' });
    return { method, path, status: 403 };
  }
  if (registration.outcome === 'machine-bound-elsewhere') {
    sendJson(response, 403, { error: 'this machine is already identified by another key' });
    return { method, path, status: 403 };
  }
  sendJson(response, 200, { machine: registration.machine });
  return { method, path, status: 200 };
}
