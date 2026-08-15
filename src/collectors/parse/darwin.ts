/**
 * Parsers for the macOS collector: `ps` for the process table and `lsof` in
 * field mode for working directories and listening sockets.
 */

import type { PortBinding, Protocol } from '../../types.js';
import { splitAddressPort } from './linux.js';

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly user: string;
  readonly startedAt: Date | null;
  readonly command: string;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * `lstart` prints five tokens in the C locale: `Thu Aug 13 10:58:35 2026`.
 * Anything else returns null rather than a wrong timestamp.
 */
export function parseLstart(tokens: readonly string[]): Date | null {
  if (tokens.length < 5) return null;
  const month = MONTHS[(tokens[1] ?? '').slice(0, 3).toLowerCase()];
  const day = Number.parseInt(tokens[2] ?? '', 10);
  const time = (tokens[3] ?? '').split(':').map((part) => Number.parseInt(part, 10));
  const year = Number.parseInt(tokens[4] ?? '', 10);
  if (month === undefined || !Number.isFinite(day) || !Number.isFinite(year) || time.length !== 3) return null;
  if (time.some((n) => !Number.isFinite(n))) return null;
  return new Date(year, month, day, time[0]!, time[1]!, time[2]!);
}

/**
 * Output of `ps -axwwo pid=,ppid=,user=,lstart=,command=`.
 * The column widths are not fixed, but the field count before `command` is:
 * three tokens, then the five tokens of lstart, then the rest is the command.
 */
export function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^\s*PID\b/i.test(line)) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 9) continue;

    const pid = Number.parseInt(tokens[0] ?? '', 10);
    const ppid = Number.parseInt(tokens[1] ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;

    const user = tokens[2] ?? '';
    const startedAt = parseLstart(tokens.slice(3, 8));

    // Rebuild the command from the original line so inner spacing survives.
    const commandStart = indexOfNthToken(line, 8);
    const command = commandStart === -1 ? tokens.slice(8).join(' ') : line.slice(commandStart);

    rows.push({ pid, ppid, user, startedAt, command });
  }
  return rows;
}

/** Character offset of token number `n` (zero based) in a whitespace split line. */
function indexOfNthToken(line: string, n: number): number {
  let index = 0;
  let token = 0;
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index]!)) index += 1;
    if (index >= line.length) return -1;
    if (token === n) return index;
    while (index < line.length && !/\s/.test(line[index]!)) index += 1;
    token += 1;
  }
  return -1;
}

export interface LsofRecord {
  readonly pid: number;
  readonly command: string | null;
  readonly names: readonly string[];
}

/**
 * `lsof -F` field output: one field per line, first character is the field id.
 * `p` starts a process block, `c` is its command, `n` is a file or socket name.
 */
export function parseLsofFields(output: string): LsofRecord[] {
  const records: LsofRecord[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  let names: string[] = [];

  const flush = (): void => {
    if (pid !== null) records.push({ pid, command, names });
    pid = null;
    command = null;
    names = [];
  };

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine === '') continue;
    const tag = rawLine[0];
    const value = rawLine.slice(1);
    if (tag === 'p') {
      flush();
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (tag === 'c') {
      command = value;
      continue;
    }
    if (tag === 'n') {
      names.push(value);
    }
  }
  flush();
  return records;
}

/** `lsof -a -d cwd -Fpn` gives one directory per process. */
export function parseLsofCwd(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const record of parseLsofFields(output)) {
    const first = record.names[0];
    if (first !== undefined && first !== '') map.set(record.pid, first);
  }
  return map;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -Fpn`. Names look like `*:4310`,
 * `127.0.0.1:4310` or `[::1]:4310`.
 */
export function parseLsofPorts(output: string, protocol: Protocol = 'tcp'): PortBinding[] {
  const bindings: PortBinding[] = [];
  for (const record of parseLsofFields(output)) {
    for (const name of record.names) {
      const withoutState = name.replace(/\s*\((LISTEN|ESTABLISHED|CLOSE_WAIT|[A-Z_]+)\)\s*$/, '');
      if (withoutState.includes('->')) continue; // an established connection, not a bound port
      const parsed = splitAddressPort(withoutState);
      if (!parsed) continue;
      const stateMatch = /\(([A-Z_]+)\)\s*$/.exec(name);
      const state = stateMatch ? (stateMatch[1] ?? '').toLowerCase() : 'listen';
      bindings.push({
        protocol,
        address: parsed.address,
        port: parsed.port,
        state,
        pid: record.pid,
      });
    }
  }
  return bindings;
}
