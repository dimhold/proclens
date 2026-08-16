import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseLsofCwd, parseLsofFields, parseLsofPorts, parseLstart, parsePs } from '../src/collectors/parse/darwin.js';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parsePs', () => {
  const rows = parsePs(read('darwin-ps.txt'));

  it('reads every row', () => {
    expect(rows).toHaveLength(6);
  });

  it('keeps the whole command, including the arguments after it', () => {
    const vite = rows.find((r) => r.pid === 9120);
    expect(vite?.command).toBe(
      'node /Users/dev/projects/shop-web/node_modules/vite/bin/vite.js dev --port 4310',
    );
  });

  it('keeps a command whose own path contains spaces', () => {
    const chrome = rows.find((r) => r.pid === 9801);
    expect(chrome?.command).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(chrome?.command).toContain('chrome-devtools-mcp/chrome-profile');
  });

  it('parses the five token lstart column', () => {
    const vite = rows.find((r) => r.pid === 9120);
    expect(vite?.startedAt?.getFullYear()).toBe(2026);
    expect(vite?.startedAt?.getMonth()).toBe(7);
    expect(vite?.startedAt?.getDate()).toBe(14);
  });

  it('reads the owning user', () => {
    expect(rows.find((r) => r.pid === 1)?.user).toBe('root');
    expect(rows.find((r) => r.pid === 1150)?.user).toBe('_postgres');
  });

  it('keeps a process reparented to init, which is how macOS shows an orphan', () => {
    expect(rows.find((r) => r.pid === 9412)?.ppid).toBe(1);
  });

  it('returns null for an unparseable date instead of a wrong one', () => {
    expect(parseLstart(['Xxx', 'Zzz', '32', 'nope', '2026'])).toBeNull();
    expect(parseLstart(['Thu', 'Aug'])).toBeNull();
  });

  it('skips a header line and blank lines', () => {
    expect(parsePs('  PID  PPID USER  STARTED COMMAND\n\n')).toEqual([]);
  });
});

describe('parseLsofFields', () => {
  it('groups name lines under the process block that precedes them', () => {
    const records = parseLsofFields('p10\ncnode\nf1\nn/a\nn/b\np11\ncpython\nn/c\n');
    expect(records).toEqual([
      { pid: 10, command: 'node', names: ['/a', '/b'] },
      { pid: 11, command: 'python', names: ['/c'] },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseLsofFields('')).toEqual([]);
  });
});

describe('parseLsofCwd', () => {
  it('maps each pid to its working directory', () => {
    const cwds = parseLsofCwd(read('darwin-lsof-cwd.txt'));
    expect(cwds.get(9120)).toBe('/Users/dev/projects/shop-web');
    expect(cwds.get(1150)).toBe('/opt/homebrew/var/postgresql@16');
    expect(cwds.has(9999)).toBe(false);
  });
});

describe('parseLsofPorts', () => {
  const bindings = parseLsofPorts(read('darwin-lsof-ports.txt'), 'tcp');

  it('maps a wildcard listener to its pid', () => {
    expect(bindings.find((b) => b.port === 4310)).toMatchObject({ address: '0.0.0.0', pid: 9120, state: 'listen' });
  });

  it('unwraps a bracketed IPv6 address', () => {
    expect(bindings.find((b) => b.port === 4311)).toMatchObject({ address: '::1', pid: 9412 });
  });

  it('ignores an established connection, which is not a held port', () => {
    expect(bindings.some((b) => b.pid === 9601)).toBe(false);
  });

  it('reads the state when lsof appends one', () => {
    const withState = parseLsofPorts('p10\nn*:3000 (LISTEN)\n');
    expect(withState[0]).toMatchObject({ port: 3000, state: 'listen' });
  });
});
