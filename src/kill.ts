/**
 * Killing is the one destructive thing whotop does, so it is deliberately
 * narrow: it resolves the target first, shows what it found, and asks.
 */

import { createInterface } from 'node:readline/promises';
import type { ProcessView } from './types.js';

export type KillSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

export interface KillOutcome {
  readonly pid: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface KillDeps {
  /** Injected so tests never signal a real process. */
  readonly send?: (pid: number, signal: KillSignal) => void;
  readonly confirm?: (question: string) => Promise<boolean>;
}

const defaultSend = (pid: number, signal: KillSignal): void => {
  process.kill(pid, signal);
};

/**
 * Windows has no signals: Node maps every signal to TerminateProcess, so
 * SIGTERM there is as abrupt as SIGKILL. Say so rather than implying a
 * graceful shutdown that will not happen.
 */
export function signalNote(platform: NodeJS.Platform, signal: KillSignal): string | null {
  if (platform !== 'win32') return null;
  return `Windows has no signals; ${signal} becomes TerminateProcess and the target gets no chance to clean up.`;
}

export function describeTarget(view: ProcessView, port?: number): string {
  const parts = [`pid ${view.pid}`, view.classification.label ?? view.name];
  if (port !== undefined) parts.push(`holding port ${port}`);
  if (view.cwd.value) parts.push(`in ${view.cwd.value}`);
  if (view.orphan.value === true) parts.push('orphan');
  return parts.join(', ');
}

export async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function killProcesses(
  targets: readonly ProcessView[],
  signal: KillSignal,
  deps: KillDeps = {},
): Promise<KillOutcome[]> {
  const send = deps.send ?? defaultSend;
  const outcomes: KillOutcome[] = [];
  for (const target of targets) {
    try {
      send(target.pid, signal);
      outcomes.push({ pid: target.pid, ok: true });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      const reason =
        err.code === 'ESRCH'
          ? 'the process had already exited'
          : err.code === 'EPERM'
            ? 'permission denied; it belongs to another user or runs elevated'
            : err.message;
      outcomes.push({ pid: target.pid, ok: false, error: reason });
    }
  }
  return outcomes;
}
