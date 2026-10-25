import { randomUUID } from 'node:crypto';
import { hostname as hostName } from 'node:os';

import type { Command } from '@commander-js/extra-typings';

import {
  assertKeySafeUrl,
  checkKey,
  fetchMeta,
  incompatibility,
  registerMachine,
  type Fetch,
} from '../../cloud/client.js';
import {
  credentialsPath,
  ensureMachineKey,
  readCredentials,
  readMachineKey,
  writeCredentials,
} from '../../cloud/settings.js';
import { bearerFor } from '../../cloud/tokens.js';
import { VERSION } from '../../version.js';

/**
 * `concord hub connect` and `concord hub status` — joining this machine to a
 * private Concord hub an operator runs for their own hosts. No Concord Cloud
 * account and no browser sign-in: the key is piped on stdin, saved with this
 * machine's other credentials, and no output ever shows any of it.
 */

/** Where a non-interactive caller can put the key instead of stdin. */
export const HUB_KEY_ENV = 'CONCORD_HUB_API_KEY';

export interface HubClientDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: Fetch;
  /** Reads the key piped on stdin, for `--key-stdin`. */
  readonly readStdin: () => Promise<string>;
  readonly hostname: () => string;
  readonly newMachineKey: () => string;
}

async function hubKey(
  options: { readonly keyStdin: boolean },
  deps: HubClientDeps,
): Promise<string> {
  const key = (options.keyStdin ? await deps.readStdin() : (deps.env[HUB_KEY_ENV] ?? '')).trim();
  if (key === '') {
    throw new Error(
      `A private hub key arrives on stdin: pass --key-stdin, or set ${HUB_KEY_ENV}. ` +
        'There is no browser sign-in for a private hub.',
    );
  }
  return key;
}

/**
 * Connects this machine to the private hub at `url`, with the key the operator
 * handed out. The key is registered and saved before any output is composed,
 * and that output carries the URL and this machine's identity — never the key.
 */
export async function runHubConnect(
  options: { readonly url: string; readonly keyStdin: boolean },
  deps: HubClientDeps,
): Promise<string> {
  const apiUrl = options.url;
  const apiKey = await hubKey(options, deps);

  // A key only ever over https, or plain http to this machine: anyone on the
  // path of a remote http request could read it.
  assertKeySafeUrl(apiUrl);

  const meta = await fetchMeta(apiUrl, deps.fetch);
  const problem = incompatibility(meta);
  if (problem !== null) {
    throw new Error(`Cannot use ${apiUrl} as a private hub: ${problem}.`);
  }

  // Kept across connects, so this machine stays one machine to the hub.
  const machineKey = ensureMachineKey(deps.env, deps.newMachineKey);
  const host = deps.hostname();
  const registered = await registerMachine(
    apiUrl,
    apiKey,
    {
      machineKey,
      name: host,
      hostname: host,
      platform: process.platform,
      runtimeVersion: VERSION,
    },
    deps.fetch,
  );
  if (registered === 'rejected') {
    throw new Error(`The private hub at ${apiUrl} rejected that key.`);
  }

  writeCredentials(deps.env, { apiUrl, apiKey });
  return (
    `Connected to ${apiUrl} as machine ${machineKey} on a private hub. ` +
    `The key is saved in ${credentialsPath(deps.env)} and never shown.`
  );
}

/** What this machine knows of its private hub: the URL, its identity, never the key. */
export async function runHubStatus(deps: HubClientDeps): Promise<string> {
  const credentials = readCredentials(deps.env);
  const machine = readMachineKey(deps.env);
  if (credentials === undefined) {
    return [
      'Hub: none (run `concord hub connect --url <https-url> --key-stdin`)',
      `Machine: ${machine ?? 'none'}`,
    ].join('\n');
  }
  const lines = [
    `Hub: ${credentials.apiUrl} (private hub)`,
    `Machine: ${machine ?? 'none: run `concord hub connect` again'}`,
  ];
  // Two checks, reported apart, so a failing key check never hides an API that
  // answered — and neither check has any reason to print the key.
  try {
    const meta = await fetchMeta(credentials.apiUrl, deps.fetch);
    const problem = incompatibility(meta);
    lines.push(
      problem === null
        ? `API: reachable, v${String(meta.apiVersion)}, compatible`
        : `API: reachable but ${problem}`,
    );
  } catch (error) {
    lines.push(`API: unreachable (${error instanceof Error ? error.message : String(error)})`);
  }
  if ('apiKey' in credentials) {
    try {
      const bearer = await bearerFor(deps.env, credentials.apiUrl, deps.fetch)();
      const key = await checkKey(credentials.apiUrl, bearer, deps.fetch);
      lines.push(
        key === 'ok' ? 'Key: accepted' : 'Key: rejected — run `concord hub connect` again',
      );
    } catch (error) {
      lines.push(`Key: not checked (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines.join('\n');
}

function liveDeps(): HubClientDeps {
  return {
    env: process.env,
    fetch,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    hostname: hostName,
    newMachineKey: randomUUID,
  };
}

/** Prints a command's result, or its error as one line with a failing exit code. */
async function report(run: () => string | Promise<string>): Promise<void> {
  try {
    process.stdout.write(`${await run()}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * The client half of `concord hub`, hung off the group `hub serve` registers.
 * Its help names a private hub; it never points at a Concord Cloud account.
 */
export function registerHubClientCommand(program: Command): void {
  const hub = program.commands.find((command) => command.name() === 'hub');
  if (hub === undefined) {
    throw new Error('Register `concord hub serve` before the hub client commands.');
  }

  hub
    .command('connect')
    .description('Connect this machine to a private Concord hub, with a key its operator gave you')
    .requiredOption('--url <url>', "the private hub's base URL (https, or http on this machine)")
    .option('--key-stdin', 'read this machine’s hub key from stdin')
    .action((options) =>
      report(() =>
        runHubConnect({ url: options.url, keyStdin: options.keyStdin === true }, liveDeps()),
      ),
    );

  hub
    .command('status')
    .description('Show the private hub this machine uses and its identity there, never its key')
    .action(() => report(() => runHubStatus(liveDeps())));
}
