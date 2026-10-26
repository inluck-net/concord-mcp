import { join } from 'node:path';

import type { Command } from '@commander-js/extra-typings';

import { userHome } from '../../config/paths.js';
import { readHubKeyFile } from '../../hub/keys.js';
import { startHub, type HubServer } from '../../hub/server.js';
import { openHubStore } from '../../hub/store.js';

/**
 * `concord hub serve` — the private hub's server, on loopback. The key file is
 * the operator's: the command reads it and fails fast when it is missing or
 * invalid, and never creates one. Keys and message bodies are not logged.
 */

/**
 * The port a hub serves on when `--port` is not given. A long-running serve
 * behind Tailscale Serve needs one the operator can name in that config.
 */
export const DEFAULT_HUB_PORT = 8787;

export interface HubServeOptions {
  readonly port: number;
  readonly db: string | undefined;
  readonly keyFile: string | undefined;
}

export interface HubServeDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
}

/** The operator's key file, outside every repository. */
export function hubKeyFilePath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.concord', 'hub-keys.json');
}

/** Where the hub's durable state lives, outside every repository. */
export function hubDatabasePath(env: NodeJS.ProcessEnv): string {
  return join(userHome(env), '.concord', 'hub.db');
}

/**
 * Starts the hub on 127.0.0.1. The key file is read first, so a missing or
 * invalid one fails before anything is bound or written.
 */
export async function runHubServe(
  options: HubServeOptions,
  deps: HubServeDeps,
): Promise<HubServer> {
  const keyFile = options.keyFile ?? hubKeyFilePath(deps.env);
  const db = options.db ?? hubDatabasePath(deps.env);
  const keys = readHubKeyFile(keyFile);
  const store = openHubStore(db);
  try {
    return await startHub({ port: options.port, keys, store, log: deps.log });
  } catch (error) {
    store.close();
    throw error;
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`"${value}" is not a port number between 0 and 65535.`);
  }
  return port;
}

/** Serves until SIGINT or SIGTERM, then closes the listener. */
function stopOnSignal(hub: HubServer): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      void hub.close().then(resolve, resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/** Where the command writes, and how it stops: the process's own, or a test's. */
export interface HubCommandDeps {
  readonly env: NodeJS.ProcessEnv;
  /** Command output and request log lines, one per line. */
  readonly write: (line: string) => void;
  /** The command could not start: report it and end with a failing exit. */
  readonly fail: (message: string) => void;
  /** Keeps `hub serve` serving until the process is asked to stop. */
  readonly waitForStop: (hub: HubServer) => Promise<void>;
}

function liveDeps(): HubCommandDeps {
  return {
    env: process.env,
    write: (line) => {
      process.stderr.write(`${line}\n`);
    },
    fail: (message) => {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
    waitForStop: stopOnSignal,
  };
}

export function registerHubCommand(program: Command, commandDeps?: HubCommandDeps): void {
  const deps = commandDeps ?? liveDeps();
  const hub = program
    .command('hub')
    .description('Run a private Concord hub on this machine, for your own hosts');

  hub
    .command('serve')
    .description('Serve the Concord hub API on 127.0.0.1 (reach it remotely over Tailscale Serve)')
    .option('--port <port>', 'local port to bind on 127.0.0.1', parsePort, DEFAULT_HUB_PORT)
    .option('--db <path>', 'SQLite file for hub state (default ~/.concord/hub.db)')
    .option('--key-file <path>', 'JSON file of machine keys (default ~/.concord/hub-keys.json)')
    .action(async (options) => {
      try {
        const running = await runHubServe(
          { port: options.port, db: options.db, keyFile: options.keyFile },
          { env: deps.env, log: deps.write },
        );
        deps.write(`Concord hub listening on ${running.url}`);
        await deps.waitForStop(running);
        deps.write('Concord hub stopped.');
      } catch (error) {
        deps.fail(error instanceof Error ? error.message : String(error));
      }
    });
}
