import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import type { PortBinding } from '../src/types.js';

const listen = (port: number): PortBinding => ({
  protocol: 'tcp',
  address: '0.0.0.0',
  port,
  state: 'listen',
  pid: 1,
});

describe('classify: the cases this tool was written for', () => {
  it('names an orphaned vite dev server, the process that held port 4310', () => {
    const result = classify({
      name: 'node.exe',
      commandLine: '"node" "C:\\Users\\dev\\projects\\shop-web\\node_modules\\vite\\bin\\vite.js" dev --port 4310',
      ports: [listen(4310)],
    });
    expect(result.role).toBe('dev-server');
    expect(result.label).toBe('vite');
    expect(result.reason).toContain('vite');
  });

  it('separates an automation Chrome from an ordinary one by the profile directory', () => {
    const automated = classify({
      name: 'chrome.exe',
      commandLine:
        '"chrome.exe" --type=renderer --user-data-dir=C:\\Users\\dev\\AppData\\Local\\Temp\\chrome-devtools-mcp\\chrome-profile',
    });
    const ordinary = classify({
      name: 'chrome.exe',
      commandLine: '"chrome.exe" --type=renderer --field-trial-handle=1234',
    });
    expect(automated.role).toBe('browser-automation');
    expect(automated.reason).toContain('--user-data-dir');
    expect(ordinary.role).toBe('unknown');
  });

  it('recognises an MCP server behind a cmd.exe wrapper', () => {
    const result = classify({
      name: 'cmd.exe',
      commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "npx ^"chrome-devtools-mcp@1.7.0^""',
    });
    expect(result.role).toBe('mcp-server');
    expect(result.label).toBe('chrome-devtools-mcp');
  });

  it('recognises an agent session', () => {
    const result = classify({
      name: 'node',
      commandLine: '/usr/bin/node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    });
    expect(result.role).toBe('agent-session');
  });
});

describe('classify: roles', () => {
  const cases: Array<[string, string, string]> = [
    ['dev-server', 'node /app/node_modules/.bin/next dev', 'next dev'],
    ['dev-server', 'python -m uvicorn app:main --reload --port 8000', 'uvicorn'],
    ['dev-server', 'npm run dev', 'npm dev'],
    ['test-runner', 'node /app/node_modules/vitest/vitest.mjs run', 'vitest'],
    ['test-runner', 'python -m pytest tests/', 'pytest'],
    ['test-runner', 'pnpm test', 'pnpm test'],
    ['watcher', 'node /usr/bin/nodemon server.js', 'nodemon'],
    ['language-server', 'node /home/dev/.vscode/typescript-language-server --stdio', 'typescript-language-server'],
    ['database', '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/data', 'postgres'],
    ['container', '/usr/bin/dockerd -H fd://', 'dockerd'],
    ['tunnel', 'ngrok http 3000', 'ngrok'],
    ['mcp-server', 'node /app/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js /data', 'server-filesystem'],
  ];

  for (const [role, commandLine, label] of cases) {
    it(`classifies "${commandLine}" as ${role}`, () => {
      const result = classify({ name: 'node', commandLine });
      expect(result.role).toBe(role);
      expect(result.label).toBe(label);
    });
  }

  it('prefers the more specific rule when several fire', () => {
    // Both the watcher rule (--watch) and the test runner rule match here.
    const result = classify({ name: 'node', commandLine: 'node /app/node_modules/vitest/vitest.mjs --watch' });
    expect(result.role).toBe('test-runner');
    expect(result.matches.map((m) => m.ruleId)).toContain('watcher');
  });

  it('falls back to dev-server for an unmarked runtime that holds a port', () => {
    const result = classify({ name: 'node', commandLine: 'node /app/dist/server.js', ports: [listen(3000)] });
    expect(result.role).toBe('dev-server');
    expect(result.reason).toContain('3000');
  });

  it('calls a runtime with no script a repl', () => {
    expect(classify({ name: 'node', commandLine: 'node' }).role).toBe('repl');
  });
});

describe('classify: what it refuses to guess', () => {
  it('says the command line was missing rather than inventing a role', () => {
    const result = classify({ name: 'svchost.exe', commandLine: null });
    expect(result.role).toBe('unknown');
    expect(result.reason).toContain('not available');
  });

  it('still recognises a well known daemon from its name alone', () => {
    const result = classify({ name: 'postgres', commandLine: null });
    expect(result.role).toBe('database');
  });

  it('returns unknown for an ordinary desktop program', () => {
    expect(classify({ name: 'notepad.exe', commandLine: '"C:\\Windows\\system32\\notepad.exe"' }).role).toBe('unknown');
  });

  it('records every rule that fired, strongest first', () => {
    const result = classify({ name: 'node', commandLine: 'npm run dev -- --watch' });
    expect(result.matches.length).toBeGreaterThan(1);
    const confidences = result.matches.map((m) => m.confidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
  });
});
