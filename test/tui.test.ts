import { describe, expect, it } from 'vitest';
import {
  anchorSelection,
  indexOfPid,
  initialState,
  matchesSearch,
  moveSelection,
  splitKeys,
  visibleRows,
  windowOffset,
} from '../src/tui.js';
import { exact } from '../src/types.js';
import type { ProcessView, Snapshot } from '../src/types.js';

const view = (over: Partial<ProcessView> = {}): ProcessView => ({
  pid: 9120,
  ppid: 6104,
  name: 'node.exe',
  exePath: null,
  commandLine: exact('node vite.js dev --port 4310'),
  cwd: exact('C:\\Users\\dev\\projects\\shop-web'),
  startedAt: null,
  user: null,
  services: [],
  classification: {
    role: 'dev-server',
    confidence: 0.78,
    reason: 'vite',
    matches: [],
    label: 'vite',
  },
  ports: [],
  orphan: exact(false),
  ageMs: 3 * 3_600_000,
  project: exact('shop-web'),
  ...over,
});

const snapshot = (processes: ProcessView[]): Snapshot => ({
  platform: 'win32',
  capturedAt: new Date('2026-08-19T16:00:00.000Z'),
  capabilities: { commandLine: 'partial', cwd: 'none', ports: 'full', user: 'none', notes: [] },
  processes,
  warnings: [],
});

describe('anchorSelection', () => {
  /**
   * The rule the whole screen rests on. A refresh reorders rows whenever a
   * process exits, and a cursor that remembered "row 1" would come to rest on
   * a different process than the one the reader was looking at. Killing that
   * one is the mistake whotop exists to prevent.
   */
  it('follows the pid when the list reorders under it', () => {
    const before = [view({ pid: 100 }), view({ pid: 200 }), view({ pid: 300 })];
    const after = [view({ pid: 300 }), view({ pid: 100 }), view({ pid: 200 })];
    const index = indexOfPid(before, 200);
    expect(anchorSelection(after, 200, index)).toBe(200);
  });

  it('holds the position rather than jumping to the top when the pid is gone', () => {
    const after = [view({ pid: 100 }), view({ pid: 300 }), view({ pid: 400 })];
    expect(anchorSelection(after, 200, 1)).toBe(300);
  });

  it('clamps to the last row when the list shrank past the old position', () => {
    expect(anchorSelection([view({ pid: 100 })], 999, 7)).toBe(100);
  });

  it('selects nothing when nothing is left', () => {
    expect(anchorSelection([], 100, 0)).toBeNull();
  });
});

describe('moveSelection', () => {
  const rows = [view({ pid: 1 }), view({ pid: 2 }), view({ pid: 3 })];

  it('moves by one and stops at both ends', () => {
    expect(moveSelection(rows, 1, 1)).toBe(2);
    expect(moveSelection(rows, 1, -1)).toBe(1);
    expect(moveSelection(rows, 3, 1)).toBe(3);
  });

  it('clamps a page jump instead of falling off the list', () => {
    expect(moveSelection(rows, 1, 50)).toBe(3);
    expect(moveSelection(rows, 3, -50)).toBe(1);
  });
});

describe('windowOffset', () => {
  it('does not scroll while the cursor is already on screen', () => {
    expect(windowOffset(3, 10, 0, 40)).toBe(0);
  });

  it('scrolls by the smallest amount that brings the cursor back', () => {
    expect(windowOffset(12, 10, 0, 40)).toBe(3);
    expect(windowOffset(2, 10, 5, 40)).toBe(2);
  });

  it('never leaves a gap below the last row', () => {
    expect(windowOffset(39, 10, 35, 40)).toBe(30);
  });
});

describe('matchesSearch', () => {
  it('finds a process by the service name, which is sometimes all it discloses', () => {
    const row = view({ services: ['WireGuardTunnel$Poland-2'] });
    expect(matchesSearch(row, 'wireguard')).toBe(true);
  });

  it('finds a process by pid, port, project and command line', () => {
    const row = view({ pid: 4321, ports: [{ protocol: 'tcp', address: '::', port: 5173, state: 'listen', pid: 4321 }] });
    expect(matchesSearch(row, '4321')).toBe(true);
    expect(matchesSearch(row, '5173')).toBe(true);
    expect(matchesSearch(row, 'shop-web')).toBe(true);
    expect(matchesSearch(row, 'vite.js')).toBe(true);
  });

  it('does not match what is not there', () => {
    expect(matchesSearch(view(), 'postgres')).toBe(false);
  });
});

describe('visibleRows', () => {
  it('narrows to the search and keeps the rest reachable through show all', () => {
    const snap = snapshot([
      view({ pid: 1, services: ['Dnscache'], classification: { ...view().classification, role: 'unknown', label: null } }),
      view({ pid: 2 }),
    ]);
    const state = initialState(true, 'pid');
    expect(visibleRows(snap, state).map((r) => r.pid)).toEqual([1, 2]);
    expect(visibleRows(snap, { ...state, search: 'dnscache' }).map((r) => r.pid)).toEqual([1]);
  });
});

describe('splitKeys', () => {
  it('keeps an arrow together instead of reading it as three keys', () => {
    expect(splitKeys('\x1b[A')).toEqual(['\x1b[A']);
    expect(splitKeys('\x1b[6~')).toEqual(['\x1b[6~']);
  });

  it('splits a burst of plain keys, and a mix of both', () => {
    expect(splitKeys('abc')).toEqual(['a', 'b', 'c']);
    expect(splitKeys('j\x1b[Bk')).toEqual(['j', '\x1b[B', 'k']);
  });

  it('passes a lone escape through, which is how search is cleared', () => {
    expect(splitKeys('\x1b')).toEqual(['\x1b']);
  });
});
