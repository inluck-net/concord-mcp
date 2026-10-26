import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { z } from 'zod';

import type { Fetch } from '../cloud/client.js';

/**
 * The managed Codex launcher's private host-start control.
 *
 * A SessionStart hook must not own the long-lived session host. On Windows a
 * child of the hook — detached or not, Node or PowerShell — keeps `SessionStart`
 * at "Running hooks" for as long as that host lives. So the launcher listens on
 * loopback for one bounded, capability-authenticated request and starts
 * `host-codex` itself, outside the hook's process ancestry.
 *
 * The request may name only the session's agent id and Codex thread id. It
 * cannot choose a command, path, or argument: there is one host command, built
 * here, and the only variable parts are ids validated before they are used.
 */

/** Where the launcher publishes its host-start control, and its capability. */
export const HOST_CONTROL_ENV = 'CONCORD_CODEX_HOST_CONTROL';
export const HOST_CONTROL_TOKEN_ENV = 'CONCORD_CODEX_HOST_CONTROL_TOKEN';

/** The one path this listener answers. */
export const HOST_START_PATH = '/host/start';

/** A host-start body is two short ids; anything larger is not one. */
const MAX_REQUEST_BYTES = 4096;

/** A hook must never hang here: give the launcher a moment, then say so. */
const REQUEST_TIMEOUT_MS = 2_000;

/**
 * What a host-start request may carry. `.strict()` so a body that tries to name
 * a command, path, or argument is rejected rather than quietly ignored — a
 * request cannot steer this endpoint into starting anything but the one host.
 */
const hostStartBody = z
  .object({
    agentId: z.string().regex(/^codex:[A-Za-z0-9_-]{1,64}$/u),
    threadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  })
  .strict();

export interface HostStartRequest {
  readonly agentId: string;
  readonly threadId: string;
}

export type HostStartOutcome =
  | { readonly status: 'started' }
  | { readonly status: 'already-running' }
  | { readonly status: 'unavailable'; readonly reason: string };

/** What a client needs to reach a launcher's control: where it is, and the key. */
export type HostControlRef = Pick<HostControl, 'location' | 'capability'>;

export interface HostControl {
  /** `http://127.0.0.1:<port>` — loopback only, by construction. */
  readonly location: string;
  /** Per-launch random capability. Never logged and never sent back out. */
  readonly capability: string;
  /** Stop listening. The launcher calls this when the Codex TUI exits. */
  close: () => Promise<void>;
}

export interface HostControlOptions {
  /** Starts and owns one session host. Called only after a request validates. */
  readonly startHost: (request: HostStartRequest) => void;
  /** Short, secret-free diagnostics. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

/** The validated request, or undefined when the body is malformed. */
export function parseHostStartBody(raw: unknown): HostStartRequest | undefined {
  const parsed = hostStartBody.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The argv for the one host this control may start. Built from validated ids
 * only, so no request can name an executable, path, or extra argument.
 */
export function codexHostStartArgs(request: HostStartRequest): readonly string[] {
  return ['adapters', 'host-codex', '--agent', request.agentId, '--thread', request.threadId];
}

/** The managed environment a launcher hands its app-server and TUI. */
export function hostControlEnvironment(
  control: HostControlRef,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [HOST_CONTROL_ENV]: control.location,
    [HOST_CONTROL_TOKEN_ENV]: control.capability,
  };
}

/** A loopback host:port, the only place a capability may be sent. */
function isLoopbackLocation(location: string): boolean {
  try {
    const url = new URL(location);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

/**
 * The launcher's control, when this process runs inside a managed Codex launch.
 *
 * Only a loopback location is honoured. The capability is a secret, and this
 * would otherwise be a way for anything that can write the environment to have
 * it posted to a host of its choosing.
 */
export function hostControlFromEnv(env: NodeJS.ProcessEnv): HostControlRef | undefined {
  const location = env[HOST_CONTROL_ENV]?.trim();
  const capability = env[HOST_CONTROL_TOKEN_ENV]?.trim();
  if (
    location === undefined ||
    location === '' ||
    capability === undefined ||
    capability === '' ||
    !isLoopbackLocation(location)
  ) {
    return undefined;
  }
  return { location, capability };
}

/** Constant-time capability check: compare digests so lengths never leak. */
function capabilityMatches(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function suppliedCapability(request: IncomingMessage): string {
  const header = request.headers['x-concord-capability'];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw ?? '';
}

/**
 * The body, or undefined when it is oversized or the request fails. An
 * oversized body is drained rather than destroyed so the caller still gets a
 * refusal instead of a dropped connection.
 */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let finished = false;
    const finish = (value: string | undefined): void => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      finish(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', () => {
      finish(undefined);
    });
  });
}

/**
 * Refuse a request. The reason is a fixed phrase: neither the supplied
 * capability nor any request content is echoed into the log or the reply.
 */
function refuse(
  response: ServerResponse,
  status: number,
  reason: string,
  log: (line: string) => void,
): void {
  // Also the catch-all, so it may arrive after a reply was already written.
  if (response.headersSent) return;
  log(`Concord: host-start request rejected (${reason})`);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: reason }));
}

function accept(response: ServerResponse, status: 'started' | 'already-running'): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status }));
}

interface HandlerDeps {
  readonly capability: string;
  readonly started: Set<string>;
  readonly startHost: (request: HostStartRequest) => void;
  readonly log: (line: string) => void;
}

async function handleHostStart(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  if (request.method !== 'POST') {
    refuse(response, 405, 'method not allowed', deps.log);
    return;
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== HOST_START_PATH || url.search !== '') {
    refuse(response, 400, 'unknown endpoint', deps.log);
    return;
  }
  if (!capabilityMatches(suppliedCapability(request), deps.capability)) {
    refuse(response, 401, 'unauthorized', deps.log);
    return;
  }
  const body = await readBody(request);
  if (body === undefined) {
    refuse(response, 400, 'malformed request', deps.log);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    refuse(response, 400, 'malformed request', deps.log);
    return;
  }
  const hostRequest = parseHostStartBody(parsed);
  if (hostRequest === undefined) {
    refuse(response, 400, 'malformed request', deps.log);
    return;
  }
  // One host per session per launch: a hook that retries, or two hooks for the
  // same session, must not leave two relays racing over one inbox.
  const key = `${hostRequest.agentId} ${hostRequest.threadId}`;
  if (deps.started.has(key)) {
    accept(response, 'already-running');
    return;
  }
  deps.started.add(key);
  try {
    deps.startHost(hostRequest);
  } catch {
    deps.started.delete(key);
    refuse(response, 500, 'host start failed', deps.log);
    return;
  }
  accept(response, 'started');
}

/**
 * Listen on loopback for authenticated host-start requests until `close`.
 * The capability is minted here and is valid only for this launch.
 */
export async function startHostControl(options: HostControlOptions): Promise<HostControl> {
  const capability = randomBytes(32).toString('base64url');
  const started = new Set<string>();
  const log =
    options.log ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const deps: HandlerDeps = {
    capability,
    started,
    startHost: options.startHost,
    log,
  };
  const server = createServer((request, response) => {
    void handleHostStart(request, response, deps).catch((error: unknown) => {
      refuse(response, 500, 'host start failed', log);
      log(
        `Concord: host-start handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', (error: Error) => {
    log(`Concord: host-start listener error: ${error.message}`);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Could not listen for host-start requests on this machine.');
  }
  return {
    location: `http://127.0.0.1:${String(address.port)}`,
    capability,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Ask a managed launcher to own this session's host. Never throws and never
 * waits past `REQUEST_TIMEOUT_MS`: a hook that cannot reach its launcher must
 * return promptly and say so, not hang on a child it cannot start.
 */
export async function requestHostStart(
  control: HostControlRef,
  request: HostStartRequest,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<HostStartOutcome> {
  const validated = parseHostStartBody(request);
  if (validated === undefined) {
    return { status: 'unavailable', reason: 'malformed agent or thread id' };
  }
  let response: Response;
  try {
    response = await fetchImpl(`${control.location}${HOST_START_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-concord-capability': control.capability,
      },
      body: JSON.stringify(validated),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { status: 'unavailable', reason: 'no reachable managed launcher' };
  }
  if (response.status !== 200) {
    return {
      status: 'unavailable',
      reason: `the managed launcher refused host start (HTTP ${String(response.status)})`,
    };
  }
  const raw: unknown = await response.json().catch(() => undefined);
  const reply = z.object({ status: z.enum(['started', 'already-running']) }).safeParse(raw);
  if (!reply.success) return { status: 'unavailable', reason: 'unexpected launcher reply' };
  return { status: reply.data.status };
}
