/**
 * Role heuristics.
 *
 * The whole point of whotop is that a process table full of `node` and
 * `python` tells you nothing. Everything useful is in the command line, so
 * that is where the rules look. Each rule carries the sentence it would print
 * as evidence, because a classification you cannot check is a guess with
 * better manners.
 */

import { baseName, normalizeForMatch, packageNameFromPath, parseCommand, stripExtension } from './cmdline.js';
import type { CommandFacts } from './cmdline.js';
import type { Classification, PortBinding, Role, RoleMatch } from './types.js';

export interface ClassifyInput {
  readonly name: string;
  readonly exePath?: string | null;
  readonly commandLine?: string | null;
  readonly cwd?: string | null;
  readonly ports?: readonly PortBinding[];
}

interface RuleContext {
  readonly name: string;
  readonly haystack: string;
  readonly facts: CommandFacts;
  readonly cwd: string;
  readonly listening: readonly PortBinding[];
}

interface Rule {
  readonly id: string;
  readonly role: Role;
  readonly confidence: number;
  readonly reason: string | ((ctx: RuleContext) => string);
  readonly label?: string | ((ctx: RuleContext) => string | null);
  test(ctx: RuleContext): boolean;
}

const has =
  (...needles: string[]) =>
  (ctx: RuleContext): boolean =>
    needles.some((n) => ctx.haystack.includes(n));

const matches =
  (re: RegExp) =>
  (ctx: RuleContext): boolean =>
    re.test(ctx.haystack);

const scriptIs =
  (...names: string[]) =>
  (ctx: RuleContext): boolean => {
    const script = ctx.facts.script?.toLowerCase();
    return script !== undefined && script !== null && names.includes(script);
  };

const entryIs =
  (...names: string[]) =>
  (ctx: RuleContext): boolean => {
    const entry = ctx.facts.entryName?.toLowerCase();
    return entry !== undefined && entry !== null && names.includes(entry);
  };

/**
 * Match on the executable basename, ignoring a Windows extension.
 *
 * The agent rules were written around the npm install shape, so they look for
 * `@anthropic-ai/claude-code` or `/claude ` in the command line. A native
 * install is neither: `C:\Users\me\.local\bin\claude.exe --resume` has
 * backslashes and no trailing space, so every token missed and five live
 * sessions were classified unknown and dropped from the default view. Found
 * 2026-08-19 on a machine that was running them.
 *
 * Only names that mean one thing belong here. A bare `goose` or `gemini` is
 * somebody else's program often enough that calling it an agent session would
 * be the confident wrong answer this tool refuses to give.
 */
const nameIs =
  (...names: string[]) =>
  (ctx: RuleContext): boolean =>
    names.includes(baseBinary(ctx.name));

const baseBinary = (name: string): string => name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');

const AGENT_BINARIES = ['claude', 'cursor-agent', 'opencode', 'aider'];

/** First needle present in the haystack, for reasons that quote the evidence. */
function firstHit(ctx: RuleContext, needles: readonly string[]): string {
  return needles.find((n) => ctx.haystack.includes(n)) ?? needles[0] ?? '';
}

/**
 * A few matched tokens are shaped for matching rather than for reading. This
 * maps those to the name a person would use.
 */
const TOKEN_LABELS: Record<string, string> = {
  '/vite/': 'vite',
  'vite.js': 'vite',
  'vite dev': 'vite',
  'vite preview': 'vite',
  'manage.py runserver': 'django runserver',
  'php -s': 'php built-in server',
  'node --test': 'node:test',
  'py.test': 'pytest',
  'tsserver.js': 'tsserver',
  '@modelcontextprotocol': 'mcp server',
};

function labelFor(token: string): string {
  const mapped = TOKEN_LABELS[token];
  if (mapped) return mapped;
  return token
    .trim()
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\.(js|mjs|cjs|py)$/i, '');
}

/**
 * The argument that names a package, for labels: the last path segment,
 * without a version suffix and without a file extension. `--browser-url` and
 * other flag values are skipped so the label names the tool, not its options.
 */
function packageLikeToken(ctx: RuleContext, pattern: RegExp): string | null {
  for (const arg of ctx.facts.argv) {
    if (arg.startsWith('-') || /^\/[a-z]$/i.test(arg)) continue;
    if (!pattern.test(arg)) continue;
    if (/^[a-z]+:\/\//i.test(arg)) continue;
    const name = stripExtension(baseName(arg)).replace(/@[^@]*$/, '');
    if (name !== '') return name;
  }
  return null;
}

const AGENT_TOKENS = [
  '@anthropic-ai/claude-code',
  'claude-code',
  '/claude ',
  'claude-agent-sdk',
  '@openai/codex',
  'codex-cli',
  'cursor-agent',
  'opencode',
  '@google/gemini-cli',
  'aider',
  'goose ',
  'crush ',
] as const;

const MCP_TOKENS = [
  '@modelcontextprotocol',
  'mcp-server',
  'mcp_server',
  'mcp-config',
  '-mcp@',
  '-mcp ',
  '/mcp/',
  'fastmcp',
  '--stdio-mcp',
] as const;

const DEV_SERVER_TOKENS = [
  // `vite` has to be matched with its surroundings: a bare substring test also
  // hits `vitest`, which is a test runner and the opposite answer.
  '/vite/',
  'vite.js',
  'vite dev',
  'vite preview',
  'next dev',
  'nuxt dev',
  'webpack-dev-server',
  'webpack serve',
  'ng serve',
  'react-scripts start',
  'astro dev',
  'remix vite:dev',
  'gatsby develop',
  'storybook dev',
  'start-storybook',
  'rails server',
  'manage.py runserver',
  'flask run',
  'uvicorn',
  'hypercorn',
  'gunicorn',
  'http-server',
  'live-server',
  'browser-sync',
  'json-server',
  'hugo server',
  'jekyll serve',
  'dotnet watch run',
  'php -s',
  'wrangler dev',
  'sst dev',
  'firebase emulators',
  'expo start',
  'metro',
  'parcel serve',
  'quasar dev',
  'docusaurus start',
] as const;

const TEST_TOKENS = [
  'vitest',
  'jest',
  'mocha',
  'playwright test',
  '@playwright/test',
  'cypress run',
  'cypress open',
  'pytest',
  'py.test',
  'karma start',
  'testcafe',
  'node --test',
  'go test',
  'cargo test',
  'phpunit',
  'rspec',
  'gradle test',
  'mvn test',
  'dotnet test',
  'ava ',
  'jasmine',
] as const;

const WATCHER_TOKENS = [
  'nodemon',
  '--watch',
  ' -w ',
  'chokidar',
  'watchman',
  'cargo watch',
  'cargo-watch',
  'air -c',
  'entr ',
  'tsc-watch',
  'concurrently',
  'turbo watch',
] as const;

const BUILD_TOKENS = [
  'vite build',
  'next build',
  'webpack --mode',
  'rollup -c',
  'esbuild',
  'turbo run build',
  'cargo build',
  'gradlew',
  'gradle build',
  'mvn ',
  'make ',
  'cmake',
  'ninja',
  'tsc -p',
  'tsc --build',
  'swc ',
  'babel ',
] as const;

const LSP_TOKENS = [
  'typescript-language-server',
  'tsserver.js',
  'typingsinstaller',
  'pylsp',
  'pyright-langserver',
  'gopls',
  'rust-analyzer',
  'eslintserver',
  'jsonserver',
  'htmlserverMain',
  'clangd',
  'omnisharp',
  'jdtls',
  'lua-language-server',
  'language-server',
] as const;

const DB_TOKENS = [
  'postgres',
  'mysqld',
  'mariadbd',
  'mongod',
  'redis-server',
  'clickhouse-server',
  'elasticsearch',
  'cockroach start',
  'sqlserver',
] as const;

const CONTAINER_TOKENS = [
  'dockerd',
  'com.docker',
  'docker-compose',
  'containerd',
  'podman',
  'colima',
  'qemu-system',
  'vpnkit',
] as const;

const TUNNEL_TOKENS = ['ngrok', 'cloudflared', 'localtunnel', 'tailscaled', 'localhost.run'] as const;

const EDITOR_TOKENS = [
  'code.exe',
  'code helper',
  'vscode-server',
  'webstorm',
  'idea64',
  'pycharm',
  'sublime_text',
  'nvim',
  'zed ',
  'cursor helper',
] as const;

const BROWSER_AUTOMATION_TOKENS = [
  'chrome-devtools-mcp',
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  'puppeteer',
  'playwright/.local-browsers',
  'ms-playwright',
  '--headless=new',
  'selenium',
  'chromedriver',
  'geckodriver',
  '--enable-automation',
] as const;

/**
 * Rules are evaluated in order. Order is the tie breaker when two rules share
 * a confidence, so the more specific rule comes first.
 */
export const RULES: readonly Rule[] = [
  {
    // Sits above agent-cli because a native binary says what it is more
    // plainly than a path substring does.
    id: 'agent-binary',
    role: 'agent-session',
    confidence: 0.95,
    test: nameIs(...AGENT_BINARIES),
    reason: (ctx) => `the executable itself is an agent CLI (${ctx.name})`,
    label: (ctx) => baseBinary(ctx.name),
  },
  {
    id: 'agent-cli',
    role: 'agent-session',
    confidence: 0.92,
    test: has(...AGENT_TOKENS),
    reason: (ctx) => `command line runs an agent CLI (${labelFor(firstHit(ctx, AGENT_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, AGENT_TOKENS)).replace(/^\//, ''),
  },
  {
    id: 'browser-automation-profile',
    role: 'browser-automation',
    confidence: 0.9,
    test: matches(/--user-data-dir=\S*(chrome-profile|puppeteer|playwright|automation|mcp)/),
    reason: '--user-data-dir points at an automation profile, not the everyday browser',
    label: 'automated browser',
  },
  {
    id: 'browser-automation',
    role: 'browser-automation',
    confidence: 0.8,
    test: has(...BROWSER_AUTOMATION_TOKENS),
    reason: (ctx) => `browser automation marker in the command line (${labelFor(firstHit(ctx, BROWSER_AUTOMATION_TOKENS))})`,
    label: 'automated browser',
  },
  {
    id: 'mcp-server',
    role: 'mcp-server',
    confidence: 0.85,
    test: has(...MCP_TOKENS),
    reason: (ctx) => `MCP marker in the command line (${labelFor(firstHit(ctx, MCP_TOKENS))})`,
    label: (ctx) => packageLikeToken(ctx, /mcp/i) ?? packageNameFromPath(ctx.facts.entry) ?? 'mcp server',
  },
  {
    id: 'dev-server-script',
    role: 'dev-server',
    confidence: 0.8,
    test: scriptIs('dev', 'start', 'serve', 'dev:server', 'start:dev', 'watch:dev'),
    reason: (ctx) => `package manager running the "${ctx.facts.script}" script`,
    label: (ctx) => `${ctx.facts.packageManager ?? 'run'} ${ctx.facts.script}`,
  },
  {
    id: 'dev-server-tool',
    role: 'dev-server',
    confidence: 0.78,
    test: (ctx) => has(...DEV_SERVER_TOKENS)(ctx) || entryIs('vite', 'next', 'nuxt', 'astro')(ctx),
    reason: (ctx) => `known dev server in the command line (${labelFor(firstHit(ctx, DEV_SERVER_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, DEV_SERVER_TOKENS)) || ctx.facts.entryName,
  },
  {
    id: 'test-runner-script',
    role: 'test-runner',
    confidence: 0.8,
    test: scriptIs('test', 'test:unit', 'test:e2e', 'test:watch', 'coverage'),
    reason: (ctx) => `package manager running the "${ctx.facts.script}" script`,
    label: (ctx) => `${ctx.facts.packageManager ?? 'run'} ${ctx.facts.script}`,
  },
  {
    id: 'test-runner-tool',
    role: 'test-runner',
    confidence: 0.78,
    test: has(...TEST_TOKENS),
    reason: (ctx) => `known test runner in the command line (${labelFor(firstHit(ctx, TEST_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, TEST_TOKENS)),
  },
  {
    id: 'language-server',
    role: 'language-server',
    confidence: 0.75,
    test: has(...LSP_TOKENS),
    reason: (ctx) => `language server binary (${labelFor(firstHit(ctx, LSP_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, LSP_TOKENS)),
  },
  {
    id: 'database',
    role: 'database',
    confidence: 0.75,
    test: has(...DB_TOKENS),
    reason: (ctx) => `database server (${labelFor(firstHit(ctx, DB_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, DB_TOKENS)),
  },
  {
    id: 'container',
    role: 'container',
    confidence: 0.72,
    test: has(...CONTAINER_TOKENS),
    reason: (ctx) => `container tooling (${labelFor(firstHit(ctx, CONTAINER_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, CONTAINER_TOKENS)),
  },
  {
    id: 'tunnel',
    role: 'tunnel',
    confidence: 0.7,
    test: has(...TUNNEL_TOKENS),
    reason: (ctx) => `tunnel client (${labelFor(firstHit(ctx, TUNNEL_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, TUNNEL_TOKENS)),
  },
  {
    id: 'watcher',
    role: 'watcher',
    confidence: 0.6,
    test: has(...WATCHER_TOKENS),
    reason: (ctx) => `watch mode in the command line (${labelFor(firstHit(ctx, WATCHER_TOKENS))})`,
    label: (ctx) => (ctx.haystack.includes('nodemon') ? 'nodemon' : (ctx.facts.entryName ?? 'watch')),
  },
  {
    id: 'build',
    role: 'build',
    confidence: 0.55,
    test: has(...BUILD_TOKENS),
    reason: (ctx) => `build tool in the command line (${labelFor(firstHit(ctx, BUILD_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, BUILD_TOKENS)),
  },
  {
    id: 'editor',
    role: 'editor',
    confidence: 0.5,
    test: has(...EDITOR_TOKENS),
    reason: (ctx) => `editor process (${labelFor(firstHit(ctx, EDITOR_TOKENS))})`,
    label: (ctx) => labelFor(firstHit(ctx, EDITOR_TOKENS)),
  },
  {
    id: 'package-manager',
    role: 'package-manager',
    confidence: 0.45,
    test: (ctx) => ctx.facts.packageManager !== null,
    reason: (ctx) => `${ctx.facts.packageManager} is driving this process`,
    label: (ctx) =>
      ctx.facts.script ? `${ctx.facts.packageManager} ${ctx.facts.script}` : ctx.facts.packageManager,
  },
  {
    id: 'listening-runtime',
    role: 'dev-server',
    confidence: 0.4,
    test: (ctx) => ctx.facts.runtime !== null && ctx.listening.length > 0,
    reason: (ctx) =>
      `a ${ctx.facts.runtime} process listening on ${ctx.listening.map((p) => p.port).join(', ')} with no other marker`,
    label: (ctx) => packageNameFromPath(ctx.facts.entry) ?? ctx.facts.entryName,
  },
  {
    id: 'repl',
    role: 'repl',
    confidence: 0.35,
    test: (ctx) => ctx.facts.runtime !== null && ctx.facts.entry === null && ctx.listening.length === 0,
    reason: (ctx) => `${ctx.facts.runtime} started with no script: an interactive session`,
    label: (ctx) => `${ctx.facts.runtime} repl`,
  },
  {
    id: 'runtime',
    role: 'runtime',
    confidence: 0.2,
    test: (ctx) => ctx.facts.runtime !== null,
    reason: (ctx) => `${ctx.facts.runtime} running ${ctx.facts.entryName ?? 'something'}, no rule matched`,
    label: (ctx) => packageNameFromPath(ctx.facts.entry) ?? ctx.facts.entryName,
  },
];

const UNKNOWN: Classification = {
  role: 'unknown',
  confidence: 0,
  reason: 'no rule matched',
  matches: [],
  label: null,
};

export function classify(input: ClassifyInput): Classification {
  const commandLine = input.commandLine ?? '';
  const facts = parseCommand(commandLine);
  const ports = input.ports ?? [];
  const listening = ports.filter((p) => p.state === 'listen');

  // Match against the unwrapped command, and fall back to the process name
  // when the OS refused the command line, so a bare `postgres` or `dockerd`
  // is still recognised.
  const haystackParts = [facts.haystack];
  if (commandLine === '') haystackParts.push(normalizeForMatch(input.name));
  if (input.exePath) haystackParts.push(normalizeForMatch(input.exePath));

  const ctx: RuleContext = {
    name: input.name,
    haystack: haystackParts.join(' '),
    facts,
    cwd: input.cwd ? normalizeForMatch(input.cwd) : '',
    listening,
  };

  const fired: RoleMatch[] = [];
  for (const rule of RULES) {
    let ok = false;
    try {
      ok = rule.test(ctx);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    fired.push({
      ruleId: rule.id,
      role: rule.role,
      confidence: rule.confidence,
      reason: typeof rule.reason === 'function' ? rule.reason(ctx) : rule.reason,
    });
  }

  if (fired.length === 0) {
    if (commandLine === '') {
      return {
        ...UNKNOWN,
        reason: 'the command line was not available, so there was nothing to match on',
      };
    }
    return UNKNOWN;
  }

  // Stable sort by confidence: rule order breaks ties.
  const ranked = fired
    .map((match, index) => ({ match, index }))
    .sort((a, b) => b.match.confidence - a.match.confidence || a.index - b.index)
    .map((entry) => entry.match);

  const best = ranked[0]!;
  const bestRule = RULES.find((r) => r.id === best.ruleId)!;
  const rawLabel = typeof bestRule.label === 'function' ? bestRule.label(ctx) : (bestRule.label ?? null);

  return {
    role: best.role,
    confidence: best.confidence,
    reason: best.reason,
    matches: ranked,
    label: rawLabel && rawLabel.length > 0 ? rawLabel : null,
  };
}

export const ALL_ROLES: readonly Role[] = [
  'agent-session',
  'mcp-server',
  'browser-automation',
  'dev-server',
  'test-runner',
  'watcher',
  'build',
  'language-server',
  'package-manager',
  'database',
  'container',
  'tunnel',
  'editor',
  'repl',
  'runtime',
  'unknown',
];

/** Roles whotop shows by default: the ones a developer put there on purpose. */
export const INTERESTING_ROLES: ReadonlySet<Role> = new Set<Role>([
  'agent-session',
  'mcp-server',
  'browser-automation',
  'dev-server',
  'test-runner',
  'watcher',
  'build',
  'language-server',
  'package-manager',
  'database',
  'container',
  'tunnel',
  'repl',
]);
