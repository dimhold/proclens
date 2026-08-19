import { DarwinCollector } from './darwin.js';
import { LinuxCollector } from './linux.js';
import { WindowsCollector } from './windows.js';
import type { Collector, PlatformId } from '../types.js';

export { DarwinCollector, LinuxCollector, WindowsCollector };

export class UnsupportedPlatformError extends Error {
  constructor(readonly received: string) {
    super(
      `whotop has no collector for "${received}". Supported: win32, linux, darwin. ` +
        'Everything except process and port enumeration is platform independent, so a new collector is the only piece missing.',
    );
    this.name = 'UnsupportedPlatformError';
  }
}

/** Pick the collector for the running platform. */
export function createCollector(platform: NodeJS.Platform = process.platform): Collector {
  switch (platform as PlatformId) {
    case 'win32':
      return new WindowsCollector();
    case 'linux':
      return new LinuxCollector();
    case 'darwin':
      return new DarwinCollector();
    default:
      throw new UnsupportedPlatformError(platform);
  }
}
