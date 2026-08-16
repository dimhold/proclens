import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  inferWindowsCwd,
  normalizeWindowsState,
  parseWindowsPayload,
  parseWindowsPorts,
  parseWindowsProcesses,
} from '../src/collectors/parse/windows.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/windows-collect.json', import.meta.url)), 'utf8');

describe('parseWindowsPayload', () => {
  const result = parseWindowsPayload(fixture);

  it('reads every process row', () => {
    expect(result.processes).toHaveLength(14);
    expect(result.processes.map((p) => p.pid)).toContain(9120);
  });

  it('marks a withheld command line as unavailable and explains why', () => {
    const system = result.processes.find((p) => p.pid === 4);
    expect(system?.commandLine.value).toBeNull();
    expect(system?.commandLine.source).toBe('unavailable');
    expect(system?.commandLine.note).toMatch(/elevated/);
  });

  it('warns about how many command lines were withheld instead of hiding it', () => {
    expect(result.warnings.join(' ')).toMatch(/2 of 14 processes did not disclose a command line/);
  });

  it('parses creation dates into real timestamps', () => {
    const vite = result.processes.find((p) => p.pid === 9120);
    expect(vite?.startedAt?.toISOString()).toBe('2026-08-14T09:02:11.450Z');
  });
});

describe('parseWindowsPorts', () => {
  const ports = parseWindowsPayload(fixture).ports;

  it('maps a port to its owning pid', () => {
    const held = ports.filter((p) => p.port === 4310);
    expect(held).toHaveLength(2);
    expect(new Set(held.map((p) => p.pid))).toEqual(new Set([9120]));
  });

  it('normalises connection states', () => {
    expect(normalizeWindowsState('Listen')).toBe('listen');
    expect(normalizeWindowsState('Established')).toBe('established');
    expect(normalizeWindowsState(null)).toBe('unknown');
  });

  it('treats a UDP endpoint as listening, because Windows reports no state for it', () => {
    const udp = ports.find((p) => p.protocol === 'udp');
    expect(udp?.state).toBe('listen');
  });

  it('drops the pid when Windows reports 0, rather than inventing an owner', () => {
    const udp = ports.find((p) => p.protocol === 'udp');
    expect(udp?.pid).toBeNull();
  });

  it('skips malformed rows instead of throwing', () => {
    const bad = parseWindowsPorts([
      { addr: '::', port: Number.NaN, state: 'Listen', pid: 1, proto: 'tcp' },
      { addr: '::', port: 8080, state: 'Listen', pid: 2, proto: 'tcp' },
    ]);
    expect(bad).toHaveLength(1);
  });
});

describe('inferWindowsCwd', () => {
  it('infers a project directory from an absolute path in the command line', () => {
    const field = inferWindowsCwd(
      '"node" "C:\\Users\\dev\\projects\\shop-web\\node_modules\\vite\\bin\\vite.js" dev',
    );
    expect(field.value).toBe('C:\\Users\\dev\\projects\\shop-web');
    expect(field.source).toBe('inferred');
  });

  it('unwraps a cmd.exe command before looking for paths', () => {
    const field = inferWindowsCwd(
      'C:\\Windows\\system32\\cmd.exe /d /s /c "node ^"C:\\Users\\dev\\projects\\api\\server.js^""',
    );
    expect(field.value).toBe('C:\\Users\\dev\\projects\\api');
  });

  it('ignores the runtime under Program Files and the Windows directory', () => {
    const field = inferWindowsCwd('"C:\\Program Files\\nodejs\\node.exe"');
    expect(field.value).toBeNull();
    expect(field.source).toBe('unavailable');
  });

  it('says the value is unavailable rather than guessing when there is no path', () => {
    const field = inferWindowsCwd('node');
    expect(field.source).toBe('unavailable');
    expect(field.note).toMatch(/does not expose the working directory/);
  });

  it('returns unavailable when there is no command line at all', () => {
    expect(inferWindowsCwd(null).source).toBe('unavailable');
  });
});

describe('parseWindowsProcesses', () => {
  it('ignores rows without a usable pid', () => {
    const parsed = parseWindowsProcesses([
      { pid: Number.NaN, ppid: 1, name: 'x', exe: null, cmd: null, start: null },
      { pid: 10, ppid: 1, name: 'y', exe: null, cmd: 'y', start: null },
    ]);
    expect(parsed.map((p) => p.pid)).toEqual([10]);
  });

  it('drops a ppid of 0, which is the idle process rather than a parent', () => {
    const parsed = parseWindowsProcesses([{ pid: 10, ppid: 0, name: 'y', exe: null, cmd: 'y', start: null }]);
    expect(parsed[0]?.ppid).toBeNull();
  });

  it('throws a readable error when the payload is not JSON', () => {
    expect(() => parseWindowsPayload('not json')).toThrow(/could not parse the PowerShell output/);
  });
});
