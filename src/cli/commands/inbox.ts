import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';

import { resolveRepoRoot, workspaceIdForRoot } from '../../config/paths.js';
import { globalInstructionsFor } from '../../install/instructions.js';
import type { ClaimOptions, Repositories } from '../../db/index.js';
import {
  capabilityFor,
  effectiveEndpointCapabilities,
  encodeCapabilities,
  monitorCapabilityFor,
  type EndpointCapability,
} from '../../domain/delivery.js';
import { grokMonitorNudge } from '../../domain/grok-monitor.js';
import { harnessConfigFor } from '../../domain/harness-config.js';
import { hookSessionId, resolveSessionId } from '../../domain/identity.js';
import { sessionKey } from '../../domain/receipts.js';
import {
  renderGeminiAfterAgent,
  renderGeminiAfterTool,
  renderHookPayload,
  renderMonitorLines,
  toDeliverable,
  type DeliverableMessage,
} from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import type { TelemetryRecorder } from '../../telemetry/events.js';
import { resolveAgentId, resolveInboxOwner } from '../agent-identity.js';
import { resolveStore } from '../../workspaces/store.js';
import { openContext } from '../context.js';
import { launchDetachedConcord } from '../detached-host.js';
import {
  codexHostStartArgs,
  hostControlFromEnv,
  requestHostStart,
  type HostStartRequest,
} from '../codex-host-control.js';
import { isSubagentHook, observeHookEvent, parseObservedHook } from './inbox-observe.js';
import {
  cloudAccess,
  drainFromCloud,
  HOOK_TIMEOUT_MS,
  registerInCloud,
  watchCloud,
  watching,
} from './cloud-inbox.js';

/** How long a registered pull endpoint stays promptable between drains. */
const PULL_ENDPOINT_TTL_MS = 90_000;
/** A receiver that misses this many seconds of polls is no longer advertised. */
const MIN_RECEIVER_TTL_MS = 10_000;

function receiverExpiry(interval: number, now = Date.now()): string {
  return new Date(now + Math.max(MIN_RECEIVER_TTL_MS, interval * 3)).toISOString();
}

function heartbeatReceiver(repos: Repositories, agentId: string, interval: number): void {
  const endpoint = repos.agentEndpoints.getByAgent(agentId);
  if (endpoint === undefined) throw new Error(`Agent ${agentId} has no registered endpoint.`);
  repos.agentEndpoints.heartbeatReceiver(endpoint.endpointId, receiverExpiry(interval));
}

/**
 * Advertise that `agentId` can receive messages by draining them from inside
 * its own session. Re-registering refreshes the lease, so a session that dies
 * stops looking promptable instead of silently swallowing messages.
 */
export function registerPullEndpoint(
  repos: Repositories,
  agentId: string,
  provider: string,
  now = Date.now(),
  capability: EndpointCapability = capabilityFor(provider),
): void {
  // The endpoint references an agent row. Hook execution order is not
  // guaranteed, so do not assume the presence hook has already run — otherwise
  // whether messaging works depends on which SessionStart hook fired first.
  ensureAgentRegistered(repos, { agentId, kind: provider }, process.cwd());
  const existing = repos.agentEndpoints.getByAgent(agentId);
  const preservePush = existing?.transport === 'local-ipc' && existing.status === 'connected';
  const preserveReceiver = effectiveEndpointCapabilities(existing, now).includes('idle');
  const capabilities =
    preservePush || preserveReceiver
      ? [...new Set([...(existing?.capabilities ?? []), ...encodeCapabilities(capability)])]
      : encodeCapabilities(capability);
  repos.agentEndpoints.upsert({
    endpointId: existing?.endpointId ?? randomUUID(),
    agentId,
    provider,
    transport: preservePush ? existing.transport : capability.transport,
    capabilities,
    address: preservePush ? existing.address : `${capability.transport}:${agentId}`,
    credentialHash: existing?.credentialHash ?? randomBytes(32).toString('hex'),
    status: 'connected',
    expiresAt: new Date(now + PULL_ENDPOINT_TTL_MS).toISOString(),
  });
}

/**
 * Take every sent message for `agentId` and mark it delivered to the session
 * in `options`. Draining is what records delivery, so a message is only ever
 * counted as delivered once the recipient's session has been handed it. It is
 * never counted as read here: that takes evidence from the session itself.
 */
export function drainInbox(
  repos: Repositories,
  agentId: string,
  provider: string,
  capability: EndpointCapability = capabilityFor(provider),
  options: ClaimOptions = {},
): DeliverableMessage[] {
  registerPullEndpoint(repos, agentId, provider, Date.now(), capability);
  const claimed = repos.agentMessages.claimPendingForRecipient(agentId, provider, options);
  repos.agents.touch(agentId);
  return claimed.map(toDeliverable);
}

/** The opaque key of the session this command runs for, when it can tell. */
export function currentSession(provider: string, hookPayload: string | undefined): string | null {
  const raw = resolveSessionId(process.env, {
    kind: provider,
    ...(hookPayload === undefined ? {} : { hookPayload }),
  });
  return raw === undefined ? null : sessionKey(raw);
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && code.startsWith('SQLITE_BUSY');
}

/**
 * Poll until a monitor receives a message or the owning harness stops it.
 * Signal listeners are removed on every completion path: leaving them attached
 * keeps Node's event loop alive after `--once`, which prevents harnesses such
 * as Gemini from observing the background command completion.
 */
export async function watchInbox(
  repos: Repositories,
  agentId: string,
  provider: string,
  interval: number,
  once: boolean,
  emit: (messages: readonly DeliverableMessage[]) => void,
): Promise<void> {
  const monitorCapability = monitorCapabilityFor(provider);
  const session = currentSession(provider, undefined);
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      process.off('SIGINT', stopWatching);
      process.off('SIGTERM', stopWatching);
      try {
        registerPullEndpoint(repos, agentId, provider);
        const endpoint = repos.agentEndpoints.getByAgent(agentId);
        if (endpoint !== undefined) repos.agentEndpoints.clearReceiver(endpoint.endpointId);
      } catch (registrationError) {
        if (error === undefined) error = registrationError;
      }
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error('Inbox monitor failed.'));
    };
    const poll = (): void => {
      let messages: DeliverableMessage[];
      try {
        messages = drainInbox(repos, agentId, provider, monitorCapability, {
          session,
          via: 'monitor',
        });
        heartbeatReceiver(repos, agentId, interval);
      } catch (error) {
        // A monitor is the session's live receive endpoint. Transient SQLite
        // contention must delay a poll, never tear that endpoint down.
        if (isSqliteBusy(error)) {
          timer = setTimeout(poll, interval);
          return;
        }
        finish(error);
        return;
      }
      if (messages.length > 0) emit(messages);
      if (once && messages.length > 0) {
        finish();
        return;
      }
      timer = setTimeout(poll, interval);
    };
    function stopWatching(): void {
      finish();
    }
    process.once('SIGINT', stopWatching);
    process.once('SIGTERM', stopWatching);
    poll();
  });
}

/**
 * Whether this repository already uses Concord.
 *
 * The relay plugin is installed once and then loads in every session, including
 * repositories that have nothing to do with Concord. Opening a workspace
 * creates it, so these commands must check first and stay quiet otherwise —
 * merely having the plugin installed should never litter unrelated projects
 * with `.concord/` state.
 */
/**
 * Read a hook payload piped on stdin. Only ever called behind `--from-hook`:
 * a plugin monitor's stdin may stay open for the life of the session, and
 * blocking on it there would silently wedge message delivery.
 */
function readHookPayload(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return undefined;
  }
}

export function registeredLine(agentId: string, provider: string): string {
  // A harness monitor may not inherit the session's environment (Grok's does
  // not), so hand the agent the exact command with its id already filled in.
  const monitor = harnessConfigFor(provider)?.monitor.command?.replace('<agent-id>', agentId);
  return (
    `Concord: this session is agent \`${agentId}\` and can receive live messages from other ` +
    `agents. If a Concord tool asks for agent_id, use "${agentId}"; do not invent a ` +
    'different id.' +
    (monitor === undefined ? '' : ` Start its inbox monitor with: \`${monitor}\`.`) +
    '\n'
  );
}

/**
 * What a hook needs to point its session at this workspace: the id to pass to
 * Concord's tools, and, for a repository in the machine-wide store, the
 * instructions it has no file of its own for.
 */
export function workspaceStatus(cwd: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const repoRoot = resolveRepoRoot(cwd, env);
  const store = resolveStore(repoRoot, env);
  return {
    workspace_id: workspaceIdForRoot(repoRoot),
    store: store.kind,
    ...(store.kind === 'global'
      ? { project: store.project, instructions: globalInstructionsFor(env) }
      : {}),
  };
}

/**
 * Whether hooks here have a workspace to serve. A repository's own store must
 * already exist; the machine-wide store counts as soon as global mode chooses
 * it, since a session's first hook can run before its MCP server creates it.
 */
export function workspaceExists(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const store = resolveStore(resolveRepoRoot(cwd, env), env);
    return store.kind === 'global' || existsSync(store.databasePath);
  } catch {
    return false;
  }
}

/**
 * Where this session's idle host ended up running.
 *
 * `idle-wake-limited` is the honest outcome on Windows without a reachable
 * managed launcher: the session is registered and still exchanges messages on
 * its own turns, but nothing will wake it while it sits idle.
 */
export type CodexHostHandoffResult =
  | { readonly kind: 'launcher-owned'; readonly status: 'started' | 'already-running' }
  | { readonly kind: 'detached' }
  | { readonly kind: 'idle-wake-limited'; readonly reason: string };

export interface CodexHostHandoff {
  readonly repoRoot: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly env: NodeJS.ProcessEnv;
  /** `process.platform`, so the Windows-only limitation is testable anywhere. */
  readonly platform: string;
  /** Stands in for the hook's own detached host start. */
  readonly detach?: (request: HostStartRequest) => void;
}

/** What a session loses without a host owner, and the little it keeps. */
function idleWakeLimitation(detail: string): string {
  return (
    `Concord: idle messages cannot wake this Codex session (${detail}). ` +
    'They will reach it on its next turn. Start Codex with `concord adapters codex` ' +
    'so its launcher can run the session host.'
  );
}

/**
 * Get one session's idle host running, without ever owning its lifetime.
 *
 * Under a managed launch the launcher already listens for this request and
 * starts `host-codex` itself, outside this process. A hook that spawns the host
 * instead leaves a long-lived child in SessionStart's process ancestry, and on
 * Windows Codex holds the hook at "Running hooks" for exactly as long as that
 * child lives. So with no reachable launcher on Windows there is no safe way to
 * start one from here: say so and return, rather than reintroduce the stall.
 * Elsewhere the detached host is the behaviour that already ships.
 */
export async function handOffCodexHost(
  handoff: CodexHostHandoff,
  report: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Promise<CodexHostHandoffResult> {
  const request: HostStartRequest = { agentId: handoff.agentId, threadId: handoff.threadId };
  const detach =
    handoff.detach ??
    ((toStart: HostStartRequest): void => {
      launchDetachedConcord(handoff.repoRoot, codexHostStartArgs(toStart), handoff.env);
    });
  const control = hostControlFromEnv(handoff.env);
  if (control !== undefined) {
    const outcome = await requestHostStart(control, request);
    if (outcome.status !== 'unavailable') return { kind: 'launcher-owned', status: outcome.status };
    if (handoff.platform === 'win32') {
      report(idleWakeLimitation(outcome.reason));
      return { kind: 'idle-wake-limited', reason: outcome.reason };
    }
    detach(request);
    return { kind: 'detached' };
  }
  if (handoff.platform === 'win32') {
    const reason = 'no managed launcher is reachable for this session';
    report(idleWakeLimitation(reason));
    return { kind: 'idle-wake-limited', reason };
  }
  detach(request);
  return { kind: 'detached' };
}

function recordDeliveredMessages(
  telemetry: TelemetryRecorder | undefined,
  messages: readonly DeliverableMessage[],
): void {
  for (const message of messages) {
    telemetry?.recordEvent({
      event_type: 'message_delivery',
      task_flow_id: message.taskId === null ? null : telemetry.taskPseudonym(message.taskId),
      message_kind: message.messageKind,
      stage: 'receive',
      result: 'delivered',
      delivery_mode: 'pull',
      error_code: null,
      latency_ms: message.deliveryLatencyMs,
    });
  }
}

/** Drain formats a hook prints, as opposed to a monitor or a script. */
const HOOK_FORMATS: readonly string[] = [
  'post-tool-use',
  'stop',
  'gemini-after-tool',
  'gemini-after-agent',
];

const DRAIN_FORMATS: readonly string[] = [
  'json',
  'monitor',
  'gemini-after-tool',
  'gemini-after-agent',
  'post-tool-use',
  'stop',
];

/** Writes drained messages in a hook's or a monitor's format. */
function writeMessages(format: string, messages: readonly DeliverableMessage[]): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(messages)}\n`);
    return;
  }
  if (format === 'monitor') {
    for (const line of renderMonitorLines(messages)) process.stdout.write(`${line}\n`);
    return;
  }
  if (format === 'gemini-after-tool') {
    process.stdout.write(renderGeminiAfterTool(messages));
    return;
  }
  if (format === 'gemini-after-agent') {
    process.stdout.write(renderGeminiAfterAgent(messages));
    return;
  }
  if (format === 'post-tool-use' || format === 'stop') {
    process.stdout.write(renderHookPayload(format, messages));
    return;
  }
  throw new Error(`Unknown --format: ${format}`);
}

/** Keeps a Grok turn open once so the agent starts the monitor its plugin cannot. */
function writeMonitorNudge(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

/** A cloud failure in a hook: said once on stderr, never failing the session's turn. */
function reportCloudFailure(
  detail: string,
  report: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): void {
  report(`Concord Cloud could not be reached: ${detail}`);
}

export interface RegisterSessionInput {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly agent: string | undefined;
  readonly provider: string;
  /** A SessionStart payload, when this runs behind `--from-hook`. */
  readonly hookPayload: string | undefined;
  /** `process.platform`; only Windows gets the idle-wake limitation. */
  readonly platform: string;
  /** The identity line, on stdout. */
  readonly write: (text: string) => void;
  /** A hook's diagnostics, on stderr. */
  readonly report: (line: string) => void;
  /** Stands in for the hook's own detached host start. */
  readonly detach?: (request: HostStartRequest) => void;
}

export interface RegisterSessionResult {
  /** Null when this directory has nothing to register into. */
  readonly agentId: string | null;
  /** Where the Codex idle host went, when this session needs one. */
  readonly host: CodexHostHandoffResult | null;
}

/**
 * Advertise one session as able to receive messages, and place its idle host.
 *
 * Everything a SessionStart hook does lives here, so the hook itself only has
 * to read its payload and print what this returns. It always returns promptly:
 * a Codex host lives far longer than a hook may, and one that ran inside the
 * hook would hold the hook open for its whole life.
 */
export async function registerSession(input: RegisterSessionInput): Promise<RegisterSessionResult> {
  const access = cloudAccess(input.cwd, { timeoutMs: HOOK_TIMEOUT_MS }, input.env);
  if (access.kind === 'local' && !workspaceExists(input.cwd, input.env)) {
    return { agentId: null, host: null };
  }
  if (access.kind === 'unusable') {
    reportCloudFailure(access.reason, input.report);
    return { agentId: null, host: null };
  }
  const agentId = resolveAgentId(input.agent, input.env, {
    kind: input.provider,
    ...(input.hookPayload === undefined ? {} : { hookPayload: input.hookPayload }),
  });
  const threadId = input.hookPayload === undefined ? undefined : hookSessionId(input.hookPayload);
  const handoff = async (repoRoot: string, id: string): Promise<CodexHostHandoffResult> =>
    handOffCodexHost(
      {
        repoRoot,
        agentId,
        threadId: id,
        env: input.env,
        platform: input.platform,
        ...(input.detach === undefined ? {} : { detach: input.detach }),
      },
      input.report,
    );

  if (access.kind === 'cloud') {
    try {
      await registerInCloud(access.runtime, agentId, input.provider, input.cwd);
    } catch (error) {
      reportCloudFailure(error instanceof Error ? error.message : String(error), input.report);
      return { agentId: null, host: null };
    }
    // Codex is delivered to live by a host on this machine; start one
    // unless one already holds this session's receiver.
    const host =
      input.provider === 'codex' && threadId !== undefined && !watching(access.runtime, agentId)
        ? await handoff(access.runtime.repoRoot, threadId)
        : null;
    input.write(registeredLine(agentId, input.provider));
    return { agentId, host };
  }

  const context = openContext(input.cwd, input.env);
  const existing =
    input.provider === 'codex' ? context.repos.agentEndpoints.getByAgent(agentId) : undefined;
  registerPullEndpoint(context.repos, agentId, input.provider);
  // A SessionStart payload says whether this is a fresh session, which
  // takes back what an earlier session was handed but never read.
  if (input.hookPayload !== undefined) observeHookEvent(context.repos, agentId, input.hookPayload);
  const alreadyHosted =
    existing?.transport === 'local-ipc' &&
    existing.status === 'connected' &&
    (existing.expiresAt === null || Date.parse(existing.expiresAt) > Date.now());
  const host =
    input.provider === 'codex' && threadId !== undefined && !alreadyHosted
      ? await handoff(context.repoRoot, threadId)
      : null;
  // Name the id. Clients whose session Concord can read resolve it on every
  // tool call; clients that scrub their environment (Codex) cannot, and for
  // those this line is the only place the agent learns who it is.
  input.write(registeredLine(agentId, input.provider));
  return { agentId, host };
}

export function registerInboxCommand(program: Command, telemetry?: TelemetryRecorder): void {
  const inbox = program
    .command('inbox')
    .description('Receive live messages other agents addressed to this session');

  inbox
    .command('status')
    .description('Exit 0 when this directory is a Concord workspace, 1 otherwise')
    .option('--cloud', 'Exit 0 only when the repository is linked to Concord Cloud')
    .option('--json', 'Print the workspace id and the store it uses, for hooks')
    .action((options) => {
      // Lets the relay monitor bail out of a project that does not use Concord
      // instead of polling for the life of the session.
      const access = cloudAccess(process.cwd());
      if (access.kind === 'unusable') {
        // Nothing here can receive messages until the machine logs in again.
        process.stderr.write(`Concord Cloud: ${access.reason}\n`);
        process.exitCode = 1;
        return;
      }
      if (access.kind === 'cloud') {
        process.stdout.write(
          options.json === true ? '{"store":"cloud"}\n' : 'Concord Cloud workspace linked.\n',
        );
        return;
      }
      if (options.cloud === true || !workspaceExists(process.cwd())) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        options.json === true
          ? `${JSON.stringify(workspaceStatus(process.cwd(), process.env))}\n`
          : 'Concord workspace present.\n',
      );
    });

  inbox
    .command('register')
    .description('Advertise this session as able to receive messages by draining them')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option('--from-hook', 'Read the session id from a hook payload on stdin (Codex)')
    .action(async (options) => {
      const hookPayload = options.fromHook === true ? (readHookPayload() ?? '') : undefined;
      await registerSession({
        cwd: process.cwd(),
        env: process.env,
        agent: options.agent,
        provider: options.provider,
        hookPayload,
        platform: process.platform,
        write: (text) => {
          process.stdout.write(text);
        },
        report: (line) => {
          process.stderr.write(`${line}\n`);
        },
      });
    });

  inbox
    .command('drain')
    .description('Print and acknowledge every message waiting for this agent')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option('--from-hook', 'Read the session id from a hook payload on stdin (Codex)')
    .option(
      '--payload-stdin',
      'Read a hook payload on stdin for read receipts only; identity still comes from --agent',
    )
    .option(
      '--format <format>',
      'post-tool-use and stop emit hook JSON; monitor emits one line per message; json emits raw records',
      'json',
    )
    .action(async (options) => {
      const access = cloudAccess(process.cwd(), { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      // Checked before anything is taken: a format typo must not cost a batch.
      if (!DRAIN_FORMATS.includes(options.format)) {
        throw new Error(`Unknown --format: ${options.format}`);
      }
      if (access.kind === 'unusable') {
        reportCloudFailure(access.reason);
        return;
      }
      const grokStop = options.provider === 'grok' && options.format === 'stop';
      // Hook formats only ever run as hooks, whose stdin always ends, so the
      // payload (read evidence, subagent marker) is safe to read even without
      // --from-hook. Identity still comes from it only with --from-hook.
      const hookPayload =
        options.fromHook === true ||
        options.payloadStdin === true ||
        HOOK_FORMATS.includes(options.format)
          ? (readHookPayload() ?? '')
          : undefined;
      const agentId = resolveInboxOwner(options.agent, process.env, {
        kind: options.provider,
        ...(options.fromHook === true ? { hookPayload } : {}),
      });
      const nudge =
        grokStop && hookPayload !== undefined ? grokMonitorNudge(hookPayload, agentId) : undefined;
      if (access.kind === 'cloud') {
        let messages: DeliverableMessage[];
        try {
          messages = await drainFromCloud(access.runtime, agentId, options.provider);
        } catch (error) {
          reportCloudFailure(error instanceof Error ? error.message : String(error));
          return;
        }
        if (messages.length > 0) writeMessages(options.format, messages);
        else if (nudge !== undefined) writeMonitorNudge(nudge);
        return;
      }
      // A subagent shares its parent's session id, so its hooks resolve the
      // parent's agent. Draining there would hand the parent's messages to
      // whichever subagent ran a tool, and its activity proves nothing about
      // what the parent's model saw (#216).
      if (hookPayload !== undefined && isSubagentHook(parseObservedHook(hookPayload))) return;
      const context = openContext(process.cwd());
      const isMonitor = options.format === 'monitor';
      // Read evidence first, so this invocation never marks read a message it
      // is itself about to deliver.
      if (hookPayload !== undefined) observeHookEvent(context.repos, agentId, hookPayload);
      const messages = drainInbox(
        context.repos,
        agentId,
        options.provider,
        isMonitor ? monitorCapabilityFor(options.provider) : capabilityFor(options.provider),
        {
          session: currentSession(options.provider, hookPayload),
          via: isMonitor ? 'monitor' : 'hook',
        },
      );
      if (isMonitor) heartbeatReceiver(context.repos, agentId, 2_000);
      // Silence matters: a hook that prints on an empty inbox would inject
      // noise into the session on every single tool call.
      if (messages.length === 0) {
        if (nudge !== undefined) writeMonitorNudge(nudge);
        return;
      }
      recordDeliveredMessages(telemetry, messages);
      writeMessages(options.format, messages);
    });

  inbox
    .command('observe')
    .description('Record what a session hook saw: messages shown to the agent, or a fresh start')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the hook payload')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .action((options) => {
      // Seen-tracking lives in the local store; Concord Cloud keeps its own
      // delivery record. Prints nothing: UserPromptSubmit output becomes context.
      const access = cloudAccess(process.cwd(), { timeoutMs: HOOK_TIMEOUT_MS });
      if (access.kind !== 'local' || !workspaceExists(process.cwd())) return;
      try {
        const payload = readHookPayload() ?? '';
        const agentId = resolveAgentId(options.agent, process.env, {
          kind: options.provider,
          hookPayload: payload,
        });
        observeHookEvent(openContext(process.cwd()).repos, agentId, payload);
      } catch (error) {
        // Never fail the hook: a missed observation only leaves a message unseen.
        process.stderr.write(
          `Concord: could not record hook event: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });

  inbox
    .command('watch')
    .description('Wait for messages and emit one line per message for a harness monitor')
    .option('--agent <id>', 'Agent id; defaults to the current harness session')
    .option('--provider <name>', 'Client the agent runs in', 'grok')
    .option('--interval <ms>', 'Polling interval in milliseconds', '1000')
    .option('--once', 'Exit after emitting the first non-empty batch')
    .option('--from-hook', 'Read the native session id from a hook payload on stdin')
    .option('--format <format>', 'Output format: monitor or stop', 'monitor')
    .action(async (options) => {
      const access = cloudAccess(process.cwd());
      if (access.kind === 'local' && !workspaceExists(process.cwd())) return;
      if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
      const hookPayload = options.fromHook === true ? (readHookPayload() ?? '') : undefined;
      const agentId = resolveInboxOwner(options.agent, process.env, {
        kind: options.provider,
        ...(hookPayload === undefined ? {} : { hookPayload }),
      });
      if (options.format !== 'monitor' && options.format !== 'stop') {
        throw new Error(`Unknown --format: ${options.format}`);
      }
      const format = options.format;
      if (access.kind === 'cloud') {
        // Long-polls the cloud, so --interval does not apply.
        await watchCloud(
          access.runtime,
          agentId,
          options.provider,
          options.once === true,
          (messages) => {
            writeMessages(format, messages);
          },
        );
        return;
      }
      const context = openContext(process.cwd());
      const parsedInterval = Number.parseInt(options.interval, 10);
      if (!Number.isFinite(parsedInterval) || parsedInterval < 250) {
        throw new Error('--interval must be at least 250 milliseconds.');
      }
      await watchInbox(
        context.repos,
        agentId,
        options.provider,
        parsedInterval,
        options.once === true,
        (messages) => {
          recordDeliveredMessages(telemetry, messages);
          writeMessages(format, messages);
        },
      );
    });
}
