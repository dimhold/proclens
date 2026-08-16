import { describe, expect, it } from 'vitest';
import { parseCommand, tokenize, unwrapShell } from '../src/cmdline.js';

describe('tokenize', () => {
  it('splits a plain command line', () => {
    expect(tokenize('node server.js --port 4310')).toEqual(['node', 'server.js', '--port', '4310']);
  });

  it('keeps quoted paths with spaces in one argument', () => {
    expect(tokenize('"C:\\Program Files\\nodejs\\node.exe" server.js')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'server.js',
    ]);
  });

  it('treats backslashes as literal unless they escape a quote', () => {
    expect(tokenize('"C:\\Users\\dev\\" next')).toEqual(['C:\\Users\\dev" next']);
    expect(tokenize('a\\\\"b c"')).toEqual(['a\\b c']);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenize('  node    a.js\tb.js ')).toEqual(['node', 'a.js', 'b.js']);
  });

  it('returns an empty array for an empty command line', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('unwrapShell', () => {
  it('unwraps cmd.exe with caret escapes, which is how Windows spawns through a shell', () => {
    const raw =
      'C:\\Windows\\system32\\cmd.exe /d /s /c "npx ^"chrome-devtools-mcp@1.7.0^" ^"--browser-url^" ^"http://127.0.0.1:9222^""';
    const unwrapped = unwrapShell(raw);
    expect(unwrapped?.shell).toBe('cmd');
    expect(unwrapped?.inner).toBe('npx "chrome-devtools-mcp@1.7.0" "--browser-url" "http://127.0.0.1:9222"');
  });

  it('unwraps sh -c', () => {
    expect(unwrapShell("/bin/sh -c 'npm run dev'")?.inner).toBe('npm run dev');
  });

  it('leaves a command that is not a shell alone', () => {
    expect(unwrapShell('node server.js -c config.json')).toBeNull();
  });

  it('returns null when the shell was started without -c', () => {
    expect(unwrapShell('/bin/bash --login')).toBeNull();
  });
});

describe('parseCommand', () => {
  it('finds the runtime and the entry script', () => {
    const facts = parseCommand('"node" "C:\\projects\\shop\\node_modules\\vite\\bin\\vite.js" dev --port 4310');
    expect(facts.runtime).toBe('node');
    expect(facts.entryName).toBe('vite');
  });

  it('finds the npm script behind npm-cli.js, which is how npm appears in a process table', () => {
    const facts = parseCommand('"node" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev');
    expect(facts.packageManager).toBe('npm');
    expect(facts.script).toBe('dev');
  });

  it('reads the script from a direct package manager invocation', () => {
    expect(parseCommand('pnpm test').script).toBe('test');
    expect(parseCommand('yarn dev').script).toBe('dev');
    expect(parseCommand('npm run build --silent').script).toBe('build');
  });

  it('reports the shell it unwrapped and the command that actually runs', () => {
    const facts = parseCommand('cmd.exe /d /s /c "npx ^"vitest^" run"');
    expect(facts.shell).toBe('cmd');
    expect(facts.effective).toBe('npx "vitest" run');
    expect(facts.haystack).toContain('vitest');
  });

  it('normalises separators and case for matching', () => {
    expect(parseCommand('C:\\Tools\\Node.EXE Server.JS').haystack).toBe('c:/tools/node.exe server.js');
  });
});
