import { LinuxBackend } from './linux.js';
import { MacBackend } from './macos.js';
import { WindowsBackend } from './windows.js';
import { Backend } from './base.js';

/** Pick the OS backend for this process. */
export function createBackend(opts, platform = process.platform) {
  switch (platform) {
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return new LinuxBackend(opts);
    case 'darwin':
      return new MacBackend(opts);
    case 'win32':
      return new WindowsBackend(opts);
    default:
      return new (class extends Backend {
        get name() {
          return `unsupported-${platform}`;
        }
      })(opts);
  }
}

export function osName(platform = process.platform) {
  return { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform] ?? platform;
}
