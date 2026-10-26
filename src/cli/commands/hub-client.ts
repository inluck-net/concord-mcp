import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  readLocalChoice,
  readMachineKey,
  removeLink,
  writeCredentials,
  writeLink,
  writeLocalChoice,
} from '../../cloud/settings.js';
import { bearerFor } from '../../cloud/tokens.js';
import { concordDir, databasePath, resolveRepoRoot } from '../../config/paths.js';
import { normalizeProjectKey } from '../../domain/project-key.js';
import { GENERAL_PROJECT, gitOriginRemote, isRepository } from '../../workspaces/store.js';
import { ensureConcordIgnored } from './setup.js';
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
  readonly cwd: string;
  /** Reads the key piped on stdin, for `--key-stdin`. */
  readonly readStdin: () => Promise<string>;
  readonly hostname: () => string;
  readonly newMachineKey: () => string;
  /** The repository's `origin` remote, or undefined when there is none. */
  readonly originRemote: (repoRoot: string) => string | undefined;
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

  const replaced = readCredentials(deps.env);
  writeCredentials(deps.env, { apiUrl, apiKey, scope: 'hub' });
  return (
    `Connected to ${apiUrl} as machine ${machineKey} on a private hub. ` +
    `The key is saved in ${credentialsPath(deps.env)} and never shown.` +
    (replaced !== undefined &&
    (replaced.apiUrl !== apiUrl || !('scope' in replaced) || replaced.scope !== 'hub')
      ? ' Previous Concord API credentials were replaced.'
      : '')
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

/**
 * Whether this URL answers as a Concord API, so a workspace is only linked to
 * a hub that is really there. An outage is reported as one — a clear,
 * retryable error — rather than as a reason the URL is wrong.
 */
async function reachableHub(apiUrl: string, fetchImpl: Fetch): Promise<void> {
  try {
    const meta = await fetchMeta(apiUrl, fetchImpl);
    const problem = incompatibility(meta);
    if (problem !== null) throw new Error(`Cannot use ${apiUrl} as a private hub: ${problem}.`);
  } catch (error) {
    const outage =
      error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
    if (!outage) throw error;
    throw new Error(
      `The private hub at ${apiUrl} could not be reached: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'It may be down, or unreachable from here; try again.',
      { cause: error },
    );
  }
}

/**
 * Joins this workspace to the private hub this machine is connected to. The
 * workspace's own link is what makes the difference — `cloudTargetFor` puts an
 * explicit link ahead of the machine's default and ahead of local state — and
 * nothing here moves, replaces or deletes an existing local database.
 */
export async function runHubLink(
  options: { readonly project: string | undefined; readonly replaceLocal: boolean },
  deps: HubClientDeps,
): Promise<string> {
  const credentials = readCredentials(deps.env);
  if (credentials === undefined) {
    throw new Error(
      'Connect this machine to a private hub first: `concord hub connect --url <https-url> --key-stdin`.',
    );
  }
  const repoRoot = resolveRepoRoot(deps.cwd, deps.env);
  const localDb = databasePath(repoRoot);
  const hasLocalState = existsSync(localDb);
  if (hasLocalState && !options.replaceLocal) {
    throw new Error(
      `${repoRoot} holds local Concord state in ${localDb}. \`concord hub link\` would make the ` +
        'private hub this workspace’s store instead — without moving or deleting that file, ' +
        'which `concord hub unlink` makes the store again. Pass --replace-local to link anyway.',
    );
  }

  if (options.project === undefined && !isRepository(repoRoot)) {
    if (!readLocalChoice(repoRoot)) {
      throw new Error(
        'Outside a repository there is nothing to link: a session here uses the private hub’s ' +
          'general workspace once this machine is connected.',
      );
    }
    await reachableHub(credentials.apiUrl, deps.fetch);
    writeLink(repoRoot, { apiUrl: credentials.apiUrl, projectKey: GENERAL_PROJECT });
    ensureConcordIgnored(concordDir(repoRoot));
    return `${repoRoot} uses the private hub's general workspace again.`;
  }

  const remote = options.project ?? deps.originRemote(repoRoot);
  if (remote === undefined) {
    throw new Error(
      'This repository has no `origin` remote. Name it with --project <remote>, ' +
        'such as github.com/org/repo, so every clone joins the same hub workspace.',
    );
  }
  const projectKey = normalizeProjectKey(remote);
  if (projectKey === null) {
    throw new Error(`"${remote}" is not a git remote, such as github.com/org/repo.`);
  }

  await reachableHub(credentials.apiUrl, deps.fetch);
  writeLink(repoRoot, { apiUrl: credentials.apiUrl, projectKey });
  ensureConcordIgnored(concordDir(repoRoot));
  return (
    `Linked ${repoRoot} to ${projectKey} on the private hub at ${credentials.apiUrl}.` +
    (hasLocalState
      ? ' Its local database is left in place; `concord hub unlink` makes it the store again.'
      : '')
  );
}

/**
 * Returns this workspace to local Concord. Only its own routing changes: the
 * local database stays where it is and readable, and the hub keeps whatever it
 * holds. The machine's own hub login is left alone.
 */
export function runHubUnlink(deps: HubClientDeps): string {
  const repoRoot = resolveRepoRoot(deps.cwd, deps.env);
  if (readLocalChoice(repoRoot)) return `${repoRoot} already works locally.`;
  if (readCredentials(deps.env) !== undefined) {
    // Signed in, the machine's default would take this workspace back; the
    // local choice is what keeps it local, as `concord cloud unlink` records.
    writeLocalChoice(repoRoot);
    ensureConcordIgnored(concordDir(repoRoot));
    return `${repoRoot} works locally again; its local database and the private hub's state are untouched.`;
  }
  return removeLink(repoRoot)
    ? `Unlinked ${repoRoot} from the private hub; Concord works locally here.`
    : `${repoRoot} was not linked to a private hub.`;
}

function liveDeps(): HubClientDeps {
  return {
    env: process.env,
    fetch,
    cwd: process.cwd(),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return Buffer.concat(chunks).toString('utf8');
    },
    hostname: hostName,
    newMachineKey: randomUUID,
    originRemote: gitOriginRemote,
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

  hub
    .command('link')
    .description('Join this workspace to the private hub this machine is connected to')
    .option('--project <remote>', 'the project to join, when the repository has no origin remote')
    .option('--replace-local', 'link even though this workspace holds local Concord state')
    .action((options) =>
      report(() =>
        runHubLink(
          { project: options.project, replaceLocal: options.replaceLocal === true },
          liveDeps(),
        ),
      ),
    );

  hub
    .command('unlink')
    .description(
      'Return this workspace to local Concord, leaving its local state and the private hub’s untouched',
    )
    .action(() => report(() => runHubUnlink(liveDeps())));
}
