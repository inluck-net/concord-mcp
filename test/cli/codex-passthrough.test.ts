import { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { codexPassthrough, runCodexPassthrough } from '../../src/cli/commands/codex-passthrough.js';

describe('codexPassthrough', () => {
  it.each([
    [['app-server'], true],
    [['app-server', '--listen', 'stdio://'], true],
    [['-c', 'model=x', 'app-server'], true],
    [['--dangerously-bypass-approvals-and-sandbox', 'exec', 'do it'], true],
    [['-m', 'exec', 'hello'], false],
    [['mcp-server'], true],
    [['--version'], true],
    [[], false],
    [['--dangerously-bypass-approvals-and-sandbox'], false],
    [['resume', '--last'], false],
    [['fork'], false],
    [['fix the failing test'], false],
    [['--', 'exec'], false],
  ] as const)('%j -> %s', (args, expected) => {
    expect(codexPassthrough(args)).toBe(expected);
  });
});

describe('runCodexPassthrough', () => {
  it('forwards SIGTERM to Codex and resolves with its exit code', async () => {
    const child = new ChildProcess();
    const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    });
    const running = runCodexPassthrough('/opt/codex', ['app-server'], {}, () => child);
    process.emit('SIGTERM', 'SIGTERM');
    await expect(running).resolves.toBe(143);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });
});
