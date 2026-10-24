import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

  it('notifies the session host when its app-server socket closes', async () => {
    const server = createServer();
    server.on('upgrade', (request, socket) => {
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.once('data', () => {
        const payload = Buffer.from(JSON.stringify({ id: 1, result: {} }));
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
        setTimeout(() => socket.end(), 10);
      });
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('No TCP address.');
      const client = new CodexDaemonClient('codex', [], `ws://127.0.0.1:${String(address.port)}`);
      const disconnected = new Promise<void>((resolve) => {
        client.onDisconnect(resolve);
      });

      await client.connect();
      await disconnected;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
