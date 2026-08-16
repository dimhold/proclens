import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWindowsPayload } from '../src/collectors/parse/windows.js';
import { filterProcesses, holdersOfPort, sortProcesses } from '../src/filter.js';
import { buildSnapshot } from '../src/inspect.js';
import { unavailable } from '../src/types.js';
import type { ProcessView } from '../src/types.js';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/windows-collect.json', import.meta.url)), 'utf8');

const processes: readonly ProcessView[] = buildSnapshot(parseWindowsPayload(fixture), {
  platform: 'win32',
  capabilities: { commandLine: 'partial', cwd: 'none', ports: 'full', user: 'none', notes: [] },
  now: new Date('2026-08-16T00:00:00.000Z'),
  resolveProject: () => unavailable<string>('stubbed in tests'),
}).processes;

const pids = (views: readonly ProcessView[]): number[] => views.map((v) => v.pid);

describe('filterProcesses', () => {
  it('hides ordinary desktop processes by default', () => {
    const shown = pids(filterProcesses(processes));
    expect(shown).not.toContain(6104); // explorer.exe
    expect(shown).not.toContain(40001); // notepad.exe
    expect(shown).toContain(9120); // the vite dev server
  });

  it('keeps an unclassified process that holds a port, which is the one you are hunting', () => {
    // postgres.exe withheld its command line, so it is only recognisable by name.
    expect(pids(filterProcesses(processes))).toContain(11500);
  });

  it('shows everything under --all', () => {
    expect(filterProcesses(processes, { all: true }).length).toBe(processes.length);
  });

  it('matches a free text query against the command line', () => {
    expect(pids(filterProcesses(processes, { query: 'chrome-profile' }))).toEqual([9800, 9801]);
  });

  it('matches a query against the working directory', () => {
    expect(pids(filterProcesses(processes, { query: 'shop-web' }))).toContain(9120);
  });

  it('filters by role', () => {
    const found = filterProcesses(processes, { roles: ['test-runner'] });
    expect(pids(found)).toEqual([9600]);
  });

  it('filters by pid, even for a process the default view would hide', () => {
    expect(pids(filterProcesses(processes, { pids: [40001] }))).toEqual([40001]);
  });

  it('filters by port', () => {
    expect(pids(filterProcesses(processes, { ports: [4311] }))).toEqual([9412]);
  });

  it('narrows to orphans', () => {
    expect(pids(filterProcesses(processes, { orphansOnly: true, all: true }))).toContain(9412);
  });

  it('narrows to processes holding a listening socket', () => {
    const listening = filterProcesses(processes, { listeningOnly: true, all: true });
    expect(pids(listening).sort((a, b) => a - b)).toEqual([9120, 9412, 9800, 11500]);
  });

  it('combines filters as AND', () => {
    expect(filterProcesses(processes, { roles: ['dev-server'], ports: [4311] })).toHaveLength(1);
    expect(filterProcesses(processes, { roles: ['test-runner'], ports: [4311] })).toHaveLength(0);
  });

  it('returns an empty list when nothing matches, without throwing', () => {
    expect(filterProcesses(processes, { query: 'nothing-like-this-exists' })).toEqual([]);
  });
});

describe('sortProcesses', () => {
  it('sorts by pid', () => {
    const sorted = pids(sortProcesses(processes, 'pid'));
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
  });

  it('sorts oldest first by age', () => {
    const ages = sortProcesses(processes, 'age').map((v) => v.ageMs ?? -1);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
  });

  it('sorts by the lowest listening port and pushes portless processes to the end', () => {
    const sorted = sortProcesses(processes, 'port');
    expect(sorted[0]?.pid).toBe(9120);
    expect(sorted[sorted.length - 1]?.ports).toHaveLength(0);
  });

  it('puts agent sessions and mcp servers before the noise when sorting by role', () => {
    const roles = sortProcesses(processes, 'role').map((v) => v.classification.role);
    expect(roles[0]).toBe('agent-session');
    expect(roles[roles.length - 1]).toBe('unknown');
  });
});

describe('holdersOfPort', () => {
  it('finds the process holding a port', () => {
    expect(pids(holdersOfPort(processes, 4310))).toEqual([9120]);
  });

  it('returns nothing for a free port', () => {
    expect(holdersOfPort(processes, 65001)).toEqual([]);
  });

  it('lists the listener first when several processes touch the same port', () => {
    expect(pids(holdersOfPort(processes, 9222))).toEqual([9800]);
  });
});
