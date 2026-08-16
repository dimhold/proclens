import { execFile } from 'node:child_process';

export interface RunResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary is missing or the call timed out. */
  readonly error: Error | null;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  /** Process tables get large; 64 MB is well past any real machine. */
  readonly maxBuffer?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run a helper binary and capture stdout. Never throws: a missing `lsof` or a
 * denied query is a warning in the report, not a crash.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 15_000, maxBuffer = 64 * 1024 * 1024, env } = options;
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8', env },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code)
          : error
            ? null
            : 0;
        resolve({
          ok: !error,
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: error ?? null,
        });
      },
    );
  });
}

/** True when the failure was "the binary does not exist here". */
export function isMissingBinary(result: RunResult): boolean {
  const err = result.error as NodeJS.ErrnoException | null;
  return err?.code === 'ENOENT';
}
