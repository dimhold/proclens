/**
 * The interactive screen: scroll, search, kill.
 *
 * Split in two on purpose. Everything above `runTui` is pure and takes no
 * terminal, so the tests exercise the parts that decide what happens, the way
 * the collectors keep parsing apart from spawning. `runTui` is the thin part
 * that owns stdin, the alternate screen and the redraw loop.
 *
 * Two rules shape the whole file.
 *
 * The selection follows a pid, never a row number. A refresh reorders the list
 * whenever a process exits or a port moves, and a cursor anchored to row 7
 * would quietly come to rest on a different process than the one the person
 * was looking at. Killing that one is the exact mistake this tool was written
 * to prevent, so it must not be reintroduced by its own screen.
 *
 * The terminal is always restored. Raw mode, the alternate screen and a hidden
 * cursor are three global changes to somebody's shell, and a crash that leaves
 * them set hands back a session that appears broken.
 */

import type { ProcessView, Snapshot } from './types.js';
import { filterProcesses, sortProcesses } from './filter.js';
import type { SortKey } from './filter.js';
import { formatAge, formatPorts, renderDetail } from './render.js';
import { killProcesses, signalNote } from './kill.js';
import type { KillSignal } from './kill.js';
import { createPalette, padEndVisible, visibleLength } from './color.js';
import type { Palette } from './color.js';

export interface TuiState {
  /** Pid the cursor sits on. Null before the first snapshot arrives. */
  readonly selected: number | null;
  /** Index of the first visible row. */
  readonly offset: number;
  readonly search: string;
  readonly searching: boolean;
  readonly showAll: boolean;
  readonly sort: SortKey;
  /** Pid awaiting a yes or no, or null when no question is open. */
  readonly confirming: number | null;
  /** Transient line under the list: the result of the last action. */
  readonly message: string | null;
  readonly detail: boolean;
}

export const initialState = (showAll: boolean, sort: SortKey): TuiState => ({
  selected: null,
  offset: 0,
  search: '',
  searching: false,
  showAll,
  sort,
  confirming: null,
  message: null,
  detail: false,
});

/**
 * Rows to draw, after the show-all toggle, the search box and the sort.
 *
 * Search deliberately looks at the same fields the `--filter` flag does plus
 * the service names, because on Windows a service name is often the only thing
 * a process discloses, and a search that could not find `WireGuardTunnel`
 * would be useless on exactly the rows that need finding.
 */
export function visibleRows(snapshot: Snapshot, state: TuiState): ProcessView[] {
  const base = filterProcesses(snapshot.processes, { all: state.showAll });
  const needle = state.search.trim().toLowerCase();
  const matched = needle === '' ? base : base.filter((view) => matchesSearch(view, needle));
  return sortProcesses(matched, state.sort);
}

/** True when any field a person would type shows the needle. */
export function matchesSearch(view: ProcessView, needle: string): boolean {
  if (needle === '') return true;
  const haystack = [
    String(view.pid),
    view.name,
    view.classification.label ?? '',
    view.classification.role,
    view.project.value ?? '',
    view.cwd.value ?? '',
    view.commandLine.value ?? '',
    ...view.services,
    ...view.ports.map((port) => String(port.port)),
  ];
  return haystack.some((field) => field.toLowerCase().includes(needle));
}

/**
 * Where the cursor lands once the list has changed under it.
 *
 * Keeps the pid when it is still there. When it is gone, holds the position in
 * the list instead of jumping to the top, so a process exiting three rows above
 * does not throw the cursor across the screen.
 */
export function anchorSelection(
  rows: readonly ProcessView[],
  previous: number | null,
  previousIndex: number,
): number | null {
  if (rows.length === 0) return null;
  if (previous !== null && rows.some((row) => row.pid === previous)) return previous;
  const index = Math.min(Math.max(previousIndex, 0), rows.length - 1);
  return rows[index]?.pid ?? null;
}

export const indexOfPid = (rows: readonly ProcessView[], pid: number | null): number =>
  pid === null ? 0 : Math.max(0, rows.findIndex((row) => row.pid === pid));

/** Move the cursor by `delta` rows and return the pid it lands on. */
export function moveSelection(rows: readonly ProcessView[], pid: number | null, delta: number): number | null {
  if (rows.length === 0) return null;
  const next = Math.min(Math.max(indexOfPid(rows, pid) + delta, 0), rows.length - 1);
  return rows[next]?.pid ?? null;
}

/**
 * Scroll offset that keeps the cursor on screen, moving as little as possible.
 * A viewport that recentres on every keypress makes the list feel like it is
 * sliding out from under the reader.
 */
export function windowOffset(index: number, height: number, offset: number, total: number): number {
  if (height <= 0 || total <= 0) return 0;
  const maxOffset = Math.max(0, total - height);
  let next = Math.min(offset, maxOffset);
  if (index < next) next = index;
  else if (index >= next + height) next = index - height + 1;
  return Math.min(Math.max(next, 0), maxOffset);
}

/** One row of the list. Kept pure so the tests can read what a person sees. */
export function renderRow(view: ProcessView, width: number, selected: boolean, palette: Palette): string {
  const pid = String(view.pid).padStart(6);
  const role = padEndVisible(view.classification.role, 18);
  const label = view.classification.label ?? view.name;
  const ports = formatPorts(view.ports);
  const age = formatAge(view.ageMs).padStart(8);
  // Service names are the only identity many Windows rows have, so they sit
  // beside the label rather than in the detail pane.
  const services = view.services.length > 0 ? ` [${view.services.join(', ')}]` : '';
  const right = `${ports.padStart(14)}${age}`;
  const room = Math.max(8, width - visibleLength(pid) - visibleLength(role) - visibleLength(right) - 3);
  const middle = padEndVisible(truncateVisible(`${label}${services}`, room), room);
  const line = ` ${pid} ${role} ${middle} ${right}`;
  return selected ? palette('inverse', padEndVisible(line, width)) : line;
}

function truncateVisible(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.slice(0, width - 1) + '…';
}

export function renderFooter(state: TuiState, rows: number, palette: Palette): string {
  if (state.confirming !== null) {
    return palette('yellow', ` kill pid ${state.confirming}?  y confirm   n cancel `);
  }
  if (state.searching) {
    return palette('cyan', ` search: ${state.search}_   enter accept   esc clear `);
  }
  if (state.message) return palette('gray', ` ${state.message}`);
  return palette(
    'gray',
    ` ${rows} rows   ↑↓ move   / search   x kill   d detail   a all   r refresh   q quit`,
  );
}

/* ------------------------------------------------------------------ *
 * Everything below owns the terminal.
 * ------------------------------------------------------------------ */

export interface TuiDeps {
  readonly collect: () => Promise<Snapshot>;
  readonly out?: NodeJS.WriteStream;
  readonly input?: NodeJS.ReadStream;
  readonly send?: (pid: number, signal: KillSignal) => void;
  /** Milliseconds between background refreshes. */
  readonly refreshMs?: number;
  readonly signal?: KillSignal;
}

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

export async function runTui(deps: TuiDeps): Promise<void> {
  const out = deps.out ?? process.stdout;
  const input = deps.input ?? process.stdin;
  const signal: KillSignal = deps.signal ?? 'SIGTERM';
  const palette = createPalette(Boolean(out.isTTY));

  if (!input.isTTY) {
    throw new Error('the interactive screen needs a terminal; run whotop without a pipe, or use the plain listing');
  }

  let state = initialState(false, 'role');
  let snapshot: Snapshot | null = null;
  let quit = false;
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      input.setRawMode(false);
    } catch {
      /* the terminal went away first */
    }
    input.pause();
    out.write(CURSOR_SHOW + ALT_SCREEN_OFF);
  };

  // Three ways out, all of them must hand the shell back intact.
  process.once('exit', restore);
  process.once('SIGINT', () => {
    restore();
    process.exit(130);
  });
  process.once('uncaughtException', (error) => {
    restore();
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });

  const draw = (): void => {
    if (!snapshot) return;
    const height = Math.max(4, (out.rows ?? 24) - 4);
    const width = out.columns ?? 100;
    const rows = visibleRows(snapshot, state);
    const index = indexOfPid(rows, state.selected);
    state = { ...state, offset: windowOffset(index, height, state.offset, rows.length) };

    const lines: string[] = [];
    const captured = snapshot.capturedAt.toLocaleTimeString();
    lines.push(
      palette('bold', ` whotop  ${snapshot.platform}  ${rows.length} of ${snapshot.processes.length} processes  ${captured}`),
    );
    lines.push('');

    if (state.detail && rows[index]) {
      lines.push(...renderDetail(rows[index], { width, palette, wide: true }));
    } else {
      const slice = rows.slice(state.offset, state.offset + height);
      for (const [i, view] of slice.entries()) {
        lines.push(renderRow(view, width, state.offset + i === index, palette));
      }
      if (slice.length === 0) lines.push(palette('gray', '  nothing matches'));
    }

    out.write(CLEAR + lines.join('\n') + '\n\n' + renderFooter(state, rows.length, palette));
  };

  const refresh = async (): Promise<void> => {
    const previousIndex = snapshot ? indexOfPid(visibleRows(snapshot, state), state.selected) : 0;
    snapshot = await deps.collect();
    const rows = visibleRows(snapshot, state);
    state = { ...state, selected: anchorSelection(rows, state.selected, previousIndex) };
    draw();
  };

  const doKill = async (pid: number): Promise<void> => {
    if (!snapshot) return;
    const target = snapshot.processes.find((view) => view.pid === pid);
    if (!target) {
      state = { ...state, message: `pid ${pid} is gone already`, confirming: null };
      draw();
      return;
    }
    const outcomes = await killProcesses([target], signal, deps.send ? { send: deps.send } : {});
    const outcome = outcomes[0];
    const note = signalNote(process.platform, signal);
    state = {
      ...state,
      confirming: null,
      message: outcome?.ok
        ? `sent ${signal} to pid ${pid}${note ? '. ' + note : ''}`
        : `could not kill pid ${pid}: ${outcome?.error ?? 'unknown reason'}`,
    };
    await refresh();
  };

  const onKey = async (key: string): Promise<void> => {
    if (!snapshot) return;
    const rows = visibleRows(snapshot, state);
    const height = Math.max(4, (out.rows ?? 24) - 4);

    if (state.confirming !== null) {
      if (key === 'y' || key === 'Y') await doKill(state.confirming);
      else state = { ...state, confirming: null, message: 'cancelled' };
      draw();
      return;
    }

    if (state.searching) {
      if (key === '\r' || key === '\n') state = { ...state, searching: false };
      else if (key === '\x1b') state = { ...state, searching: false, search: '' };
      else if (key === '\x7f' || key === '\b') state = { ...state, search: state.search.slice(0, -1) };
      else if (key >= ' ' && key <= '~') state = { ...state, search: state.search + key };
      const next = visibleRows(snapshot, state);
      state = { ...state, selected: anchorSelection(next, state.selected, 0), message: null };
      draw();
      return;
    }

    switch (key) {
      case 'q':
      case '\x03':
        quit = true;
        return;
      case '\x1b[A':
      case 'k':
        state = { ...state, selected: moveSelection(rows, state.selected, -1), message: null };
        break;
      case '\x1b[B':
      case 'j':
        state = { ...state, selected: moveSelection(rows, state.selected, 1), message: null };
        break;
      case '\x1b[5~':
        state = { ...state, selected: moveSelection(rows, state.selected, -height) };
        break;
      case '\x1b[6~':
        state = { ...state, selected: moveSelection(rows, state.selected, height) };
        break;
      case 'g':
      case '\x1b[H':
        state = { ...state, selected: rows[0]?.pid ?? null };
        break;
      case 'G':
      case '\x1b[F':
        state = { ...state, selected: rows[rows.length - 1]?.pid ?? null };
        break;
      case '/':
        state = { ...state, searching: true, search: '', message: null };
        break;
      case 'x':
      case '\x1b[20~': // F9, where htop keeps kill
        if (state.selected !== null) state = { ...state, confirming: state.selected };
        break;
      case 'd':
      case '\r':
        state = { ...state, detail: !state.detail };
        break;
      case 'a':
        state = { ...state, showAll: !state.showAll, message: null };
        break;
      case 'r':
        await refresh();
        return;
      default:
        return;
    }
    draw();
  };

  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  out.write(ALT_SCREEN_ON + CURSOR_HIDE);

  await refresh();

  // A refresh on Windows spawns PowerShell and takes a second or more, so it
  // runs on a timer rather than per keystroke, and keys stay answerable while
  // it is in flight.
  const timer = setInterval(() => {
    void refresh().catch(() => undefined);
  }, deps.refreshMs ?? 4000);
  timer.unref?.();

  try {
    for await (const chunk of input) {
      for (const key of splitKeys(String(chunk))) {
        await onKey(key);
        if (quit) break;
      }
      if (quit) break;
    }
  } finally {
    clearInterval(timer);
    restore();
  }
}

/**
 * One read can carry several keypresses, and an arrow arrives as three bytes.
 * Splitting here keeps `onKey` free of terminal trivia.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b') {
      const rest = chunk.slice(i);
      const match = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (match) {
        keys.push(match[0]);
        i += match[0].length;
        continue;
      }
    }
    keys.push(chunk[i] as string);
    i += 1;
  }
  return keys;
}
