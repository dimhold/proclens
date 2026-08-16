/**
 * Selecting rows out of a snapshot. Kept separate from rendering so that the
 * same predicates back `proclens`, `proclens port N` and `proclens kill`.
 */

import { INTERESTING_ROLES } from './classify.js';
import type { ProcessView, Role } from './types.js';

export type SortKey = 'age' | 'pid' | 'port' | 'role' | 'name';

export interface FilterOptions {
  /** Free text against name, command line, working directory and project. */
  readonly query?: string | null;
  readonly roles?: readonly Role[];
  readonly pids?: readonly number[];
  readonly ports?: readonly number[];
  /** Show every process, not just the developer-relevant roles. */
  readonly all?: boolean;
  readonly orphansOnly?: boolean;
  readonly listeningOnly?: boolean;
  readonly sort?: SortKey;
}

function haystackOf(view: ProcessView): string {
  return [
    view.name,
    view.commandLine.value ?? '',
    view.cwd.value ?? '',
    view.project.value ?? '',
    view.classification.label ?? '',
    view.classification.role,
    String(view.pid),
  ]
    .join(' ')
    .toLowerCase();
}

function lowestListeningPort(view: ProcessView): number {
  const listening = view.ports.filter((p) => p.state === 'listen');
  if (listening.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...listening.map((p) => p.port));
}

/**
 * Default view: anything proclens could name as a development role, plus
 * anything holding a port, because an unclassified process on port 4310 is
 * exactly the one you are looking for.
 */
export function isDefaultVisible(view: ProcessView): boolean {
  if (INTERESTING_ROLES.has(view.classification.role)) return true;
  return view.ports.some((p) => p.state === 'listen');
}

export function filterProcesses(
  processes: readonly ProcessView[],
  options: FilterOptions = {},
): ProcessView[] {
  const query = options.query?.trim().toLowerCase() ?? '';
  const roleSet = options.roles && options.roles.length > 0 ? new Set(options.roles) : null;
  const pidSet = options.pids && options.pids.length > 0 ? new Set(options.pids) : null;
  const portSet = options.ports && options.ports.length > 0 ? new Set(options.ports) : null;

  const explicit = Boolean(query) || roleSet !== null || pidSet !== null || portSet !== null;

  let selected = processes.filter((view) => {
    if (pidSet && !pidSet.has(view.pid)) return false;
    if (portSet && !view.ports.some((p) => portSet.has(p.port))) return false;
    if (roleSet && !roleSet.has(view.classification.role)) return false;
    if (query && !haystackOf(view).includes(query)) return false;
    if (options.orphansOnly && view.orphan.value !== true) return false;
    if (options.listeningOnly && !view.ports.some((p) => p.state === 'listen')) return false;
    // An explicit selection means the user asked for those rows by name, so
    // the default role filter steps out of the way.
    if (!options.all && !explicit && !isDefaultVisible(view)) return false;
    return true;
  });

  selected = sortProcesses(selected, options.sort ?? 'role');
  return selected;
}

const ROLE_ORDER: readonly Role[] = [
  'agent-session',
  'mcp-server',
  'dev-server',
  'browser-automation',
  'test-runner',
  'watcher',
  'build',
  'database',
  'container',
  'tunnel',
  'language-server',
  'package-manager',
  'repl',
  'editor',
  'runtime',
  'unknown',
];

export function sortProcesses(processes: readonly ProcessView[], key: SortKey): ProcessView[] {
  const list = [...processes];
  switch (key) {
    case 'pid':
      return list.sort((a, b) => a.pid - b.pid);
    case 'age':
      return list.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
    case 'port':
      return list.sort((a, b) => lowestListeningPort(a) - lowestListeningPort(b) || a.pid - b.pid);
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);
    case 'role':
    default:
      return list.sort(
        (a, b) =>
          ROLE_ORDER.indexOf(a.classification.role) - ROLE_ORDER.indexOf(b.classification.role) ||
          b.classification.confidence - a.classification.confidence ||
          a.pid - b.pid,
      );
  }
}

/** Every process holding the given port, listening sockets first. */
export function holdersOfPort(processes: readonly ProcessView[], port: number): ProcessView[] {
  return processes
    .filter((view) => view.ports.some((p) => p.port === port))
    .sort(
      (a, b) =>
        Number(b.ports.some((p) => p.port === port && p.state === 'listen')) -
          Number(a.ports.some((p) => p.port === port && p.state === 'listen')) || a.pid - b.pid,
    );
}
