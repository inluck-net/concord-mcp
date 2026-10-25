import type { Command } from '@commander-js/extra-typings';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveRepoRoot } from '../../config/paths.js';
import { readUserConfig } from '../../config/user-config.js';
import { harnessNames } from '../../domain/harness-config.js';
import { ensureHarnessAdapter } from '../../install/adapters/self-heal.js';
import { spawnCommand } from '../../install/spawn-command.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { relayAddress } from '../../relay/address.js';
import { CodexAppServerAdapter } from '../../relay/adapters.js';
import { CodexDaemonClient } from '../../relay/codex-client.js';
import { CodexReadTracker } from '../../relay/codex-read-tracker.js';
import { sessionKey } from '../../domain/receipts.js';
import { startAgentRelay, type RunningAgentRelay } from '../../relay/server.js';
import {
  executablePath,
  installGlobalAdapters,
  renderAdapterReport,
  statusGlobalAdapters,
  uninstallGlobalAdapters,
} from '../../install/adapters/index.js';
import { openContext } from '../context.js';
import { launchDetachedConcord } from '../detached-host.js';
import {
  codexHostStartArgs,
  hostControlEnvironment,
  startHostControl,
} from '../codex-host-control.js';
import { availablePort } from '../local-port.js';
import { hostCodexInCloud } from './cloud-codex.js';
import {
  copilotServerAddress,
  hostCopilot,
  hostCopilotInCloud,
  launchCopilot,
} from './copilot-adapter.js';
import { cloudAccess } from './cloud-inbox.js';

export interface HostCodexOptions {
  /** The workspace this host serves. */
  readonly cwd: string;
  /** The app-server this host drives. Defaults to the managed one in the environment. */
  readonly client?: CodexDaemonClient;
  /** Where this host's relay listens. Defaults to the workspace's runtime path. */
  readonly relayAddress?: string;
}

/**
 * Drive one Codex thread as its session host: connect to the app-server, relay
 * messages into the thread, and record read receipts. Called by the launcher
 * for a host it owns, never by the SessionStart hook that asked for one.
 */
export async function hostCodex(
  agentId: string,
  threadId: string,
  options: HostCodexOptions = { cwd: process.cwd() },
): Promise<void> {
  const context = openContext(options.cwd);
  ensureAgentRegistered(context.repos, { agentId, kind: 'codex' }, context.repoRoot);
  const client = options.client ?? new CodexDaemonClient();
  // Read receipts: the model answered, or the turn completed, with a pushed message as input.
  const session = sessionKey(threadId);
  const reads = new CodexReadTracker(threadId, (messageIds, evidence) => {
    try {
      // The read may land before the sender has recorded the push as
      // delivered; reading it proves delivery too, so record both.
      context.repos.agentMessages.markReadByEvidence(agentId, messageIds, {
        evidence,
        via: 'adapter',
        session,
      });
    } catch (error) {
      process.stderr.write(
        `Concord: could not record a read receipt: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  });
  client.onNotification((notification) => {
    reads.notify(notification);
  });
  await client.connect();
  await client.resumeThread(threadId);
  const adapter = new CodexAppServerAdapter(client, threadId, () => client.currentTurnId(), reads);
  const relay = await startAgentRelay({
    repos: context.repos,
    agentId,
    address: options.relayAddress ?? relayAddress(context.concordPath, agentId),
    adapter,
    pullFallback: true,
    session,
  });
  await keepCodexHostAlive(client, relay);
}

/** Keep a session relay alive only while its Codex app-server is reachable. */
export async function keepCodexHostAlive(
  client: Pick<CodexDaemonClient, 'onDisconnect' | 'close'>,
  relay: Pick<RunningAgentRelay, 'close'>,
): Promise<void> {
  const stop = (): void => {
    resume?.();
  };
  let resume: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      resume = resolve;
      client.onDisconnect(stop);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      await relay.close();
    } finally {
      client.close();
    }
  }
}

async function waitForCodexServer(url: string, server: ChildProcess): Promise<void> {
  const healthUrl = url.replace(/^ws:/u, 'http:') + '/readyz';
  let startupError: Error | undefined;
  server.once('error', (error) => {
    startupError = error;
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (startupError !== undefined) throw startupError;
    if (server.exitCode !== null) {
      throw new Error(
        `Codex app-server exited before it became ready (${String(server.exitCode)}).`,
      );
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The listener may not have bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the Codex app-server to become ready.');
}

export function codexManagedEnvironment(url: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, CONCORD_CODEX_APP_SERVER_URL: url };
}

export function codexManagedLaunchContext(
  repoRoot: string,
  url: string,
  env: NodeJS.ProcessEnv,
): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd: repoRoot, env: codexManagedEnvironment(url, env) };
}

async function launchCodex(args: readonly string[], repoRoot: string): Promise<void> {
  const codex = executablePath('codex', process.env);
  if (codex === undefined) throw new Error('Codex CLI was not found on PATH.');
  const port = await availablePort();
  const url = `ws://127.0.0.1:${String(port)}`;
  const tokenDirectory = mkdtempSync(join(tmpdir(), 'concord-codex-'));
  const tokenFile = join(tokenDirectory, 'app-server.token');
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CONCORD_CODEX_APP_SERVER_TOKEN_FILE: tokenFile,
  };
  // This launcher, not a SessionStart hook, owns the session's long-lived host:
  // a child of the hook holds Codex at "Running hooks" for the host's whole
  // life. The host is started from here with the same app-server coordinates
  // the managed tree runs with, so it connects back to this exact server
  // instead of falling back to daemon proxy.
  const hostEnv = codexManagedEnvironment(url, baseEnv);
  const control = await startHostControl({
    startHost: (request) => {
      launchDetachedConcord(repoRoot, codexHostStartArgs(request), hostEnv);
    },
  });
  // The app-server, not the remote TUI, owns MCP child processes, so both
  // processes get the URL and this launch's host-start control location and
  // capability. Codex intentionally filters the environment of MCP children,
  // so also run the complete managed tree from the resolved repository root.
  const context = codexManagedLaunchContext(
    repoRoot,
    url,
    hostControlEnvironment(control, baseEnv),
  );
  const server = spawnCommand(
    codex,
    ['app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile],
    {
      ...context,
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  try {
    await waitForCodexServer(url, server);
    const tui = spawnCommand(
      codex,
      ['--remote', url, '--remote-auth-token-env', 'CONCORD_CODEX_REMOTE_AUTH_TOKEN', ...args],
      {
        ...context,
        env: {
          ...context.env,
          CONCORD_CODEX_APP_SERVER_TOKEN_FILE: tokenFile,
          CONCORD_CODEX_REMOTE_AUTH_TOKEN: token,
        },
        stdio: 'inherit',
      },
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      tui.once('error', reject);
      tui.once('exit', resolve);
    });
    if (code !== null && code !== 0) process.exitCode = code;
  } finally {
    // The control is this launch's alone; it goes when the TUI does.
    await control.close();
    server.kill();
    rmSync(tokenDirectory, { recursive: true, force: true });
  }
}

export function registerAdaptersCommand(program: Command): void {
  const adapters = program.command('adapters').description('Manage global harness adapters');
  const repoRoot = (): string => resolveRepoRoot(process.cwd(), process.env);
  adapters
    .command('install')
    .description('Install adapters into every detected harness')
    .option('--require', 'exit non-zero unless every detected adapter installs')
    .action((options) => {
      const report = installGlobalAdapters(import.meta.url, process.env, repoRoot());
      process.stdout.write(`${renderAdapterReport(report)}\n`);
      if (
        options.require === true &&
        report.some((entry) => entry.detected && entry.status !== 'installed')
      ) {
        process.exitCode = 1;
      }
    });
  adapters
    .command('status')
    .description('Show detection, installation, and delivery capability by harness')
    .action(() => {
      process.stdout.write(
        `${renderAdapterReport(statusGlobalAdapters(process.env, repoRoot()))}\n`,
      );
    });
  adapters
    .command('doctor')
    .description('Probe installed adapters and explain degraded delivery')
    .action(() => {
      process.stdout.write(
        `${renderAdapterReport(statusGlobalAdapters(process.env, repoRoot()))}\n`,
      );
    });
  adapters
    .command('uninstall')
    .description('Remove only globally installed Concord adapter artifacts')
    .action(() => {
      process.stdout.write(`${renderAdapterReport(uninstallGlobalAdapters(process.env))}\n`);
    });
  adapters
    .command('ensure', { hidden: true })
    .description("Check one harness's adapter; install or repair it if the user opted in")
    .argument('<harness>', 'Harness to check')
    .action((harness) => {
      const parsed = z.enum(harnessNames).safeParse(harness);
      if (!parsed.success) throw new Error(`Unknown harness: ${harness}`);
      const result = ensureHarnessAdapter(parsed.data, {
        moduleUrl: import.meta.url,
        env: process.env,
        autoAdapters: readUserConfig(process.env).autoAdapters === true,
        repoRoot: repoRoot(),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });
  adapters
    .command('codex')
    .description('Launch Codex through a Concord-reachable local app-server')
    .argument('[args...]', 'Arguments forwarded to the Codex TUI')
    .action(async (args) => launchCodex(args, repoRoot()));
  adapters
    .command('copilot')
    .description('Launch Copilot CLI with idle wake-up through its local embedded server')
    .argument('[args...]', 'Arguments forwarded to the Copilot TUI')
    // Copilot's own flags (-i, --allow-tool, ...) are forwarded, not parsed here.
    .allowUnknownOption()
    .action(async (args) => launchCopilot(args));
  adapters
    .command('host-copilot', { hidden: true })
    .requiredOption('--agent <id>')
    .requiredOption('--session <id>')
    .option('--server <address>', "Embedded server address; defaults to the launcher's")
    .action(async (options) => {
      const address = options.server ?? copilotServerAddress();
      if (address === undefined) throw new Error('No Copilot embedded server address.');
      const access = cloudAccess(process.cwd());
      if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
      if (access.kind === 'cloud') {
        await hostCopilotInCloud(access.runtime, options.agent, options.session, address);
        return;
      }
      await hostCopilot(options.agent, options.session, address);
    });
  adapters
    .command('host-codex', { hidden: true })
    .requiredOption('--agent <id>')
    .requiredOption('--thread <id>')
    .action(async (options) => {
      const access = cloudAccess(process.cwd());
      if (access.kind === 'unusable') throw new Error(`Concord Cloud: ${access.reason}`);
      if (access.kind === 'cloud') {
        await hostCodexInCloud(access.runtime, options.agent, options.thread);
        return;
      }
      await hostCodex(options.agent, options.thread);
    });
}
