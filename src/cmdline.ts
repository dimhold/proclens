/**
 * Command-line handling: tokenising, and pulling the few structured facts
 * (runtime, entry script, npm script name) that the classifier reasons about.
 */

/**
 * Split a command line into argv.
 *
 * Windows hands back a single string, so we have to undo the quoting the same
 * way CommandLineToArgvW does: a run of backslashes is literal unless it is
 * followed by a quote, and `""` inside a quoted run means a literal quote.
 * On Unix we get argv already split, but the same function is used when a
 * collector could only recover a joined string.
 */
export function tokenize(commandLine: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  let backslashes = 0;

  const flushBackslashes = (literalCount: number): void => {
    current += '\\'.repeat(literalCount);
    backslashes = 0;
  };

  for (const char of commandLine) {
    if (char === '\\') {
      backslashes += 1;
      started = true;
      continue;
    }
    if (char === '"') {
      const pairs = Math.floor(backslashes / 2);
      const escaped = backslashes % 2 === 1;
      flushBackslashes(pairs);
      started = true;
      if (escaped) {
        current += '"';
      } else if (inQuotes) {
        inQuotes = false;
      } else {
        inQuotes = true;
      }
      continue;
    }
    flushBackslashes(backslashes);
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) {
        argv.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  flushBackslashes(backslashes);
  if (started) argv.push(current);
  return argv;
}

/** Last path segment, for either separator, without the extension. */
export function baseName(pathLike: string): string {
  const cleaned = pathLike.replace(/[\\/]+$/, '');
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return cut === -1 ? cleaned : cleaned.slice(cut + 1);
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.(exe|cmd|bat|ps1|js|cjs|mjs)$/i, '');
}

/**
 * The package a path belongs to, for command lines that end in something
 * useless like `dist/index.js`. `/app/node_modules/@scope/thing/dist/index.js`
 * gives `thing`.
 */
export function packageNameFromPath(pathLike: string | null): string | null {
  if (!pathLike) return null;
  const parts = pathLike.replace(/\\/g, '/').split('/');
  const marker = parts.lastIndexOf('node_modules');
  if (marker === -1 || marker + 1 >= parts.length) return null;
  const first = parts[marker + 1];
  if (first === undefined || first === '') return null;
  if (first.startsWith('@')) {
    const second = parts[marker + 2];
    return second !== undefined && second !== '' ? second : first;
  }
  if (first === '.bin') {
    const second = parts[marker + 2];
    return second !== undefined && second !== '' ? stripExtension(second) : null;
  }
  return first;
}

const RUNTIME_NAMES = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python2',
  'python3',
  'pythonw',
  'ruby',
  'php',
  'java',
  'dotnet',
  'perl',
]);

const SHELLS = new Set(['cmd', 'sh', 'bash', 'zsh', 'dash', 'ash', 'fish', 'pwsh', 'powershell']);

export interface ShellWrapper {
  /** The shell that was invoked: `cmd`, `bash`, ... */
  readonly shell: string;
  /** The command the shell was told to run, unescaped. */
  readonly inner: string;
}

/**
 * Unwrap `cmd.exe /d /s /c "npx ^"pkg^""` and `bash -c '...'`.
 *
 * This matters far more than it sounds. Anything spawned through a shell on
 * Windows shows up in the process table as cmd.exe with the real command
 * buried inside caret escapes, so without unwrapping, half of a developer
 * machine classifies as "cmd".
 */
export function unwrapShell(commandLine: string): ShellWrapper | null {
  const head = tokenize(commandLine)[0];
  if (head === undefined) return null;
  const shell = stripExtension(baseName(head)).toLowerCase();
  if (!SHELLS.has(shell)) return null;

  const flag = shell === 'cmd' ? /\s[/-]c\s+/i : /\s-c\s+/;
  const match = flag.exec(commandLine);
  if (!match) return null;

  // Work on the raw tail rather than on tokens: the caret escapes have to come
  // off before quoting is interpreted, or the quotes they protect are lost.
  let inner = commandLine.slice(match.index + match[0].length);
  if (shell === 'cmd') inner = inner.replace(/\^(.)/g, '$1');
  inner = stripOuterQuotes(inner.trim());
  if (inner === '') return null;

  return { shell, inner };
}

function stripOuterQuotes(text: string): string {
  const first = text[0];
  const last = text[text.length - 1];
  if (text.length > 1 && (first === '"' || first === "'") && last === first) {
    return text.slice(1, -1).trim();
  }
  return text;
}

export interface CommandFacts {
  readonly argv: readonly string[];
  /** `node`, `python3`, `java`, ... when argv[0] is a known runtime. */
  readonly runtime: string | null;
  /** The first non-flag argument after the runtime: the script being run. */
  readonly entry: string | null;
  /** Base name of the entry, e.g. `vite.js` -> `vite`. */
  readonly entryName: string | null;
  /** For `npm run dev` / `pnpm test`: the script name. */
  readonly script: string | null;
  /** The package manager driving the command, when there is one. */
  readonly packageManager: string | null;
  /** The shell the real command was hidden inside, when there was one. */
  readonly shell: string | null;
  /** The command line after shell unwrapping: what actually runs. */
  readonly effective: string;
  /** `effective`, lower-cased, separators normalised to `/`. */
  readonly haystack: string;
}

const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno']);
const PM_PASSTHROUGH = new Set(['run', 'run-script', 'exec', 'dlx', 'task']);

/**
 * Normalise a command line for matching: lower case, `\` to `/`, quotes
 * dropped. Both separators appear on Windows even inside one command line,
 * so matching on a normalised string keeps the rules readable.
 */
export function normalizeForMatch(text: string): string {
  return text.replace(/\\/g, '/').replace(/"/g, ' ').toLowerCase();
}

export function parseCommand(commandLine: string, argvHint?: readonly string[]): CommandFacts {
  const wrapper = unwrapShell(commandLine);
  const effective = wrapper ? wrapper.inner : commandLine;
  const argv = argvHint && argvHint.length > 0 ? [...argvHint] : tokenize(effective);
  const haystack = normalizeForMatch(effective);

  const head = argv[0] ?? '';
  const headName = stripExtension(baseName(head)).toLowerCase();

  let packageManager: string | null = PACKAGE_MANAGERS.has(headName) ? headName : null;
  let script: string | null = null;
  let entry: string | null = null;

  if (packageManager) {
    // `npm run dev`, `pnpm test`, `yarn dev`, `npx vitest --watch`
    const rest = argv.slice(1).filter((a) => !a.startsWith('-'));
    const first = rest[0];
    if (first !== undefined) {
      if (PM_PASSTHROUGH.has(first.toLowerCase())) {
        script = rest[1] ?? null;
      } else {
        script = first;
      }
    }
  }

  const runtime = RUNTIME_NAMES.has(headName) ? headName : null;
  if (runtime) {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-')) continue;
      entry = arg;
      break;
    }
  }

  // `node .../npm-cli.js run dev` and `node .../npx-cli.js pkg` are how the
  // package managers actually appear in a process table on every platform.
  if (entry) {
    const entryBase = stripExtension(baseName(entry)).toLowerCase();
    if (entryBase === 'npm-cli' || entryBase === 'npm') packageManager = 'npm';
    if (entryBase === 'npx-cli' || entryBase === 'npx') packageManager = 'npx';
    if (entryBase === 'yarn') packageManager = 'yarn';
    if (entryBase === 'pnpm') packageManager = 'pnpm';
    if (packageManager && script === null) {
      const after = argv.slice(argv.indexOf(entry) + 1).filter((a) => !a.startsWith('-'));
      const first = after[0];
      if (first !== undefined) {
        script = PM_PASSTHROUGH.has(first.toLowerCase()) ? (after[1] ?? null) : first;
      }
    }
  }

  return {
    argv,
    runtime,
    entry,
    entryName: entry ? stripExtension(baseName(entry)) : null,
    script,
    packageManager,
    shell: wrapper?.shell ?? null,
    effective,
    haystack,
  };
}
