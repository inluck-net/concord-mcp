import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexDaemonClient } from '../../src/relay/codex-client.js';

describe('Codex app-server WebSocket authentication', () => {
  it('sends the launch token in the Authorization header', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'concord-codex-client-test-'));
    const tokenFile = join(directory, 'token');
    writeFileSync(tokenFile, 'test-capability-token\n');
    const authorizations: (string | undefined)[] = [];
    const server = createServer();
    server.on('upgrade', (request, socket) => {
      authorizations.push(request.headers.authorization);
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No TCP address.');
      const client = new CodexDaemonClient(
        'codex',
        [],
        `ws://127.0.0.1:${String(address.port)}`,
        tokenFile,
      );

      await expect(client.connect()).rejects.toThrow('Unable to connect');
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every((value) => value === 'Bearer test-capability-token')).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
