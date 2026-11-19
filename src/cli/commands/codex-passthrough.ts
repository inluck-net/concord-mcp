import type { ChildProcess } from 'node:child_process';

import { spawnCommand } from '../../install/spawn-command.js';

/**
 * Codex subcommands that are not the interactive TUI. Codex accepts `--remote`
 * only for interactive TUI commands, so the managed launcher (its own
 * app-server plus `codex --remote`) cannot wrap these: an embedding app such as
 * Orca's chat mode runs `codex app-server` through the configured command and
 * gets `--remote … is only supported for interactive TUI commands`.
 *
 * `resume`, `fork` and `agents` open the TUI and stay managed.
 */
const PASSTHROUGH_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'migrate-nfs-db',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
]);

/** Global Codex options that take a separate value, so their value is not a subcommand. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
]);

const INFO_FLAGS: ReadonlySet<string> = new Set(['-h', '--help', '-V', '--version']);

/**
 * Whether these Codex arguments run something other than the interactive TUI,
 * and so must go to `codex` unchanged instead of through the managed launcher.
 */
export function codexPassthrough(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--') return false;
    if (INFO_FLAGS.has(arg)) return true;
    if (VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    // The first positional argument is the subcommand, or the TUI's prompt.
    return PASSTHROUGH_SUBCOMMANDS.has(arg);
  }
  return false;
}

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Run `codex <args>` as if typed, forwarding stop signals so a host that stops
 * this launcher (Orca ending a chat) also stops the Codex process it started.
 */
export async function runCodexPassthrough(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  spawnChild: (file: string, argv: readonly string[]) => ChildProcess = (file, argv) =>
    spawnCommand(file, argv, { env, stdio: 'inherit' }),
): Promise<number> {
  const child = spawnChild(executable, args);
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve(code ?? (signal === null ? 1 : 128 + signalNumber(signal)));
      });
    });
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15;
}
