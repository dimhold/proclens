import { describe, expect, it } from 'vitest';
import {
  createCollector,
  DarwinCollector,
  LinuxCollector,
  UnsupportedPlatformError,
  WindowsCollector,
} from '../src/collectors/index.js';

describe('createCollector', () => {
  it('picks the Windows collector on win32', () => {
    const collector = createCollector('win32');
    expect(collector).toBeInstanceOf(WindowsCollector);
    expect(collector.platform).toBe('win32');
  });

  it('picks the Linux collector on linux', () => {
    const collector = createCollector('linux');
    expect(collector).toBeInstanceOf(LinuxCollector);
    expect(collector.platform).toBe('linux');
  });

  it('picks the macOS collector on darwin', () => {
    const collector = createCollector('darwin');
    expect(collector).toBeInstanceOf(DarwinCollector);
    expect(collector.platform).toBe('darwin');
  });

  it('throws a nameable error for a platform it has no collector for', () => {
    expect(() => createCollector('sunos' as NodeJS.Platform)).toThrow(UnsupportedPlatformError);
    try {
      createCollector('aix' as NodeJS.Platform);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedPlatformError);
      expect((error as UnsupportedPlatformError).received).toBe('aix');
      expect((error as Error).message).toContain('win32, linux, darwin');
    }
  });
});

describe('collector capabilities', () => {
  it('states each platform honest limits, so the renderer can explain them', () => {
    expect(new WindowsCollector().capabilities.cwd).toBe('none');
    expect(new WindowsCollector().capabilities.commandLine).toBe('partial');
    expect(new LinuxCollector().capabilities.commandLine).toBe('full');
    expect(new DarwinCollector().capabilities.ports).toBe('full');
    for (const collector of [new WindowsCollector(), new LinuxCollector(), new DarwinCollector()]) {
      expect(collector.capabilities.notes.length).toBeGreaterThan(0);
    }
  });
});
