import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { expandPath } from '../core/paths.js';

/**
 * Risk classification for shell commands and GUI actions.
 *
 * Risk ladder: safe < low < medium < high < critical < forbidden.
 *  - safe:      read-only, no side effects (ls, git status, cat)
 *  - low:       ordinary local work (mkdir, builds, tests, launching apps)
 *  - medium:    side effects worth noticing (kill a process, push, network writes, local installs)
 *  - high:      destructive or system-affecting (recursive delete, installs, sudo, service changes)
 *  - critical:  could damage the system/user data at scale (rm on protected paths, shutdown, security off)
 *  - forbidden: never executed by the agent (rm -rf /, mkfs, fork bombs, disk wipes)
 *
 * The classifier is deliberately conservative and pattern based: it is a
 * guard-rail that makes intent explicit, not a sandbox. It errs on the side of
 * asking. Users tune it with allowCommands / denyCommands / protectedPaths.
 */

export const RISKS = ['safe', 'low', 'medium', 'high', 'critical', 'forbidden'];
export const riskRank = (r) => RISKS.indexOf(r);
export const maxRisk = (...rs) => rs.reduce((a, b) => (riskRank(b) > riskRank(a) ? b : a), 'safe');

/** @typedef {{risk: string, reasons: string[], categories: string[]}} Assessment */

const READ_ONLY = new Set([
  'ls', 'dir', 'll', 'la', 'cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'findstr',
  'pwd', 'cd', 'echo', 'printf', 'which', 'where', 'whereis', 'whoami', 'id', 'groups', 'hostname', 'uname', 'date', 'uptime',
  'ps', 'top', 'htop', 'pgrep', 'df', 'du', 'free', 'env', 'printenv', 'set', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp',
  'file', 'stat', 'tree', 'basename', 'dirname', 'realpath', 'readlink', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'xxd', 'od',
  'hexdump', 'strings', 'jq', 'yq', 'column', 'test', 'true', 'false', 'sleep', 'lsof', 'netstat', 'ss', 'ifconfig', 'ip',
  'nslookup', 'dig', 'ping', 'traceroute', 'tasklist', 'systeminfo', 'ver', 'sw_vers', 'system_profiler', 'lsb_release',
  'lscpu', 'lsblk', 'lsusb', 'lspci', 'xrandr', 'xdpyinfo', 'wmctrl', 'xwininfo', 'xprop', 'man', 'help', 'tldr', 'history',
  'get-childitem', 'get-content', 'get-item', 'get-process', 'get-service', 'get-location', 'get-command', 'get-help',
  'select-string', 'test-path', 'resolve-path', 'get-date', 'get-computerinfo', 'get-itemproperty', 'measure-object',
  'format-table', 'format-list', 'select-object', 'where-object', 'sort-object', 'write-output', 'write-host', 'out-string',
  'convertto-json', 'convertfrom-json', 'get-startapps', 'get-package', 'get-netipaddress', 'get-volume', 'get-psdrive',
  'mdfind', 'mdls', 'defaults-read', 'plutil', 'sysctl', 'vm_stat', 'ioreg', 'codesign', 'spctl-assess', 'xcode-select',
  'awk', 'sed', 'find', 'xargs', 'tee', 'git', 'npm', 'node', 'python', 'python3', 'pip', 'pip3', 'cargo', 'go', 'java',
]);

// Commands whose read-only-ness depends on their arguments.
const CONDITIONAL = new Set(['awk', 'sed', 'find', 'xargs', 'tee', 'git', 'npm', 'node', 'python', 'python3', 'pip', 'pip3', 'cargo', 'go', 'java']);

const SAFE_SUBCOMMANDS = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag', 'config', 'grep', 'shortlog', 'reflog', 'fetch', 'ls-remote', 'stash', 'help', 'version', '--version']),
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'search', 'help', 'config', 'root', 'prefix', 'bin', 'doctor', '-v', '--version', 'whoami', 'audit', 'explain', 'why']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'help', '--version', '-V', 'search', 'index', 'inspect']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'help', '--version', '-V', 'search', 'index', 'inspect']),
  cargo: new Set(['--version', 'tree', 'metadata', 'search', 'help', 'check', 'version']),
  go: new Set(['version', 'env', 'list', 'doc', 'help', 'vet']),
};

/** Ordered rule list: first matching rules accumulate; the highest risk wins. */
const RULES = [
  // ---- forbidden: catastrophic and never legitimately needed by an agent
  { risk: 'forbidden', cat: 'destroy-system', why: 'recursive delete of the filesystem root or home directory', re: /\brm\s+(?:-[a-z]*\s+)*-[a-z]*(?:r[a-z]*f|f[a-z]*r)[a-z]*\s+(?:-[a-z-]+\s+)*(?:--no-preserve-root\s+)?(?:\/\*?|~\/?\*?|\$home\/?\*?|\/home\/?\*?|\/users\/?\*?)(?:\s|$|;|&|\|)/i },
  { risk: 'forbidden', cat: 'destroy-system', why: '--no-preserve-root', re: /--no-preserve-root/i },
  { risk: 'forbidden', cat: 'destroy-disk', why: 'formats a filesystem', re: /(?:^|[\s;&|])mkfs(?:\.\w+)?\b|(?:^|[\s;&|])(?:format(?:\.com)?)\s+[a-z]:/i },
  { risk: 'forbidden', cat: 'destroy-disk', why: 'raw write to a block device', re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|disk|rdisk|mmcblk|vd|xvd)|>\s*\/dev\/(?:sd[a-z]|nvme\d|disk\d|rdisk\d|mmcblk\d)/i },
  { risk: 'forbidden', cat: 'destroy-disk', why: 'disk wipe utility', re: /\b(?:wipefs|shred\s+[^\n]*\/dev\/|diskutil\s+(?:erase|zero|secureerase)|cipher\s+\/w)/i },
  { risk: 'forbidden', cat: 'denial-of-service', why: 'fork bomb', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|%0\|%0/ },
  { risk: 'forbidden', cat: 'destroy-system', why: 'recursive permission change on the filesystem root', re: /\bch(?:mod|own)\s+-[a-z]*r[a-z]*\s+\S+\s+\/(?:\s|$)/i },
  { risk: 'forbidden', cat: 'destroy-system', why: 'recursive delete of a drive root or Windows directory', re: /\b(?:remove-item|rm|ri|del|erase|rd|rmdir)\b[^\n]*(?:-recurse|\/s)[^\n]*\b[a-z]:\\(?:\*|windows\b|\s|"|'|$)/i },

  // ---- critical
  { risk: 'critical', cat: 'power', why: 'shuts down or restarts the computer', re: /(?:^|[\s;&|])(?:shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(?:poweroff|reboot|halt|suspend|hibernate)|stop-computer|restart-computer|pmset\s+sleepnow)\b/i },
  { risk: 'critical', cat: 'security', why: 'disables a security control', re: /\b(?:csrutil\s+disable|spctl\s+--master-disable|setenforce\s+0|ufw\s+disable|iptables\s+-f\b|nft\s+flush|set-mppreference\b[^\n]*-disable\w*\s+\$?true|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off|set-executionpolicy\s+unrestricted|bcdedit|gatekeeper)/i },
  { risk: 'critical', cat: 'accounts', why: 'modifies user accounts or credentials', re: /(?:^|[\s;&|])(?:passwd|chpasswd|userdel|usermod|useradd|deluser|adduser|visudo|dscl\s+\S+\s+-(?:delete|create|passwd)|net\s+user\b|remove-localuser|new-localuser|set-localuser)\b/i },
  { risk: 'critical', cat: 'destroy-disk', why: 'disk partitioning', re: /\b(?:diskpart|fdisk|parted|gdisk|sgdisk|clear-disk|initialize-disk|remove-partition|format-volume)\b/i },
  { risk: 'critical', cat: 'registry', why: 'deletes machine-wide registry keys', re: /\breg(?:\.exe)?\s+delete\s+hklm|remove-item\b[^\n]*hklm:/i },
  { risk: 'critical', cat: 'process', why: 'kills init / all processes', re: /\bkill\s+(?:-\d+\s+|-[a-z]+\s+)*(?:1|-1)\b(?!\d)/i },
  { risk: 'critical', cat: 'data-loss', why: 'erases crontab', re: /\bcrontab\s+-r\b/i },

  // ---- high
  { risk: 'high', cat: 'delete', why: 'recursive delete', re: /(?:^|[\s;&|(])rm\s+(?:-[a-z]*\s+)*-[a-z]*r|(?:^|[\s;&|(])rm\s+(?:-[a-z]*\s+)*--recursive|\b(?:remove-item|ri)\b[^\n]*-r(?:ecurse)?\b|(?:^|[\s;&|])(?:rmdir|rd)\s+\/s|(?:^|[\s;&|])(?:del|erase)\s+(?:\/\w\s+)*\/s|\bshutil\.rmtree\b|\bfs\.rm(?:Sync)?\([^)]*recursive/i },
  { risk: 'high', cat: 'privilege', why: 'runs with elevated privileges', re: /(?:^|[\s;&|(])(?:sudo|doas|su|pkexec|runas|gsudo)\b|-verb\s+runas/i },
  { risk: 'high', cat: 'install', why: 'installs or removes system software', re: /\b(?:apt(?:-get)?|aptitude|dnf|yum|zypper|apk|pacman|yay|paru|emerge|xbps-install|snap|flatpak|brew|port|winget|choco|scoop)\s+(?:-\S+\s+)*(?:install|remove|purge|uninstall|upgrade|dist-upgrade|full-upgrade|autoremove|reinstall|-S\w*|-R\w*|-U\w*|cask|tap|add|update)\b/i },
  { risk: 'high', cat: 'install', why: 'installs a global package', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|rm)\b[^\n]*\s(?:-g|--global)\b|\byarn\s+global\b|\bpip3?\s+install\b[^\n]*(?:--user|--break-system-packages)|\bgem\s+install\b|\bcargo\s+install\b|\bgo\s+install\b|\bdotnet\s+tool\s+install\b[^\n]*-g|\binstall-module\b|\binstall-package\b|\bmsiexec\b|\bdpkg\s+-[ir]|\brpm\s+-[ieU]|\bsoftwareupdate\s+-i|\binstaller\s+-pkg/i },
  { risk: 'high', cat: 'remote-code', why: 'pipes downloaded content into an interpreter', re: /\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(?:python3?|perl|ruby|node|iex|invoke-expression|powershell|pwsh)\b|\biex\s*\(\s*(?:new-object\s+net\.webclient|iwr|irm|invoke-webrequest|invoke-restmethod)/i },
  { risk: 'high', cat: 'system-config', why: 'changes system services', re: /\b(?:systemctl|service)\s+(?:\S+\s+)?(?:start|stop|restart|enable|disable|mask|unmask|reload)\b|\blaunchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|kickstart|remove)\b|\bsc(?:\.exe)?\s+(?:config|stop|start|delete|create)\b|\b(?:stop|start|restart|set|new|remove)-service\b/i },
  { risk: 'high', cat: 'system-config', why: 'changes system configuration or registry', re: /\breg(?:\.exe)?\s+(?:add|delete|import|load|restore)\b|\bset-itemproperty\b[^\n]*hk(?:lm|cu):|\bnew-itemproperty\b|\bsetx\b[^\n]*\/m\b|\bdefaults\s+(?:write|delete)\b|\bscutil\s+--set\b|\bnetworksetup\s+-set|\bsysctl\s+-w\b|\bupdate-alternatives\b|\bgsettings\s+set\b|\bdconf\s+(?:write|reset|load)\b|\bchsh\b|\btimedatectl\s+set|\bhostnamectl\s+set/i },
  { risk: 'high', cat: 'system-config', why: 'writes into a system directory', re: /(?:>{1,2}|\btee\b(?:\s+-a)?)\s*["']?(?:\/etc\/|\/usr\/(?!local\/)|\/bin\/|\/sbin\/|\/boot\/|\/system\/|\/library\/(?!caches)|c:\\windows\\)|\b(?:cp|mv|install|copy|move|copy-item|move-item)\b[^\n;|&]*\s["']?(?:\/etc\/|\/usr\/(?!local\/)|\/bin\/|\/sbin\/|\/boot\/|\/system\/|\/library\/(?!caches)|c:\\windows\\)[^\s;|&]*["']?\s*(?:$|[;|&])/i },
  { risk: 'high', cat: 'git-destructive', why: 'rewrites or discards git history/work', re: /\bgit\s+(?:push\s+[^\n]*(?:--force\b|-f\b|--force-with-lease|--delete|\s:\S)|reset\s+--hard|clean\s+-[a-z]*[fdx]|checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+(?:--\S+\s+)*\.(?:\s|$)|branch\s+-D|stash\s+(?:drop|clear)|filter-branch|filter-repo|rebase\b|update-ref\s+-d|reflog\s+(?:expire|delete)|gc\s+--prune)/i },
  { risk: 'high', cat: 'publish', why: 'publishes a package or release', re: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b|\bdocker\s+push\b|\bgem\s+push\b/i },
  { risk: 'high', cat: 'containers', why: 'removes containers, images or volumes', re: /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune)|image\s+prune|container\s+prune|network\s+prune)\b|\bkubectl\s+delete\b|\bpodman\s+(?:rm|rmi|system\s+prune)\b/i },
  { risk: 'high', cat: 'permissions', why: 'recursive ownership/permission change', re: /\bch(?:mod|own|grp)\s+(?:-\w*\s+)*-\w*R|\bicacls\b[^\n]*\/(?:grant|deny|reset|setowner)[^\n]*\/t|\btakeown\b/i },
  { risk: 'high', cat: 'database', why: 'destructive database statement', re: /\b(?:drop\s+(?:database|table|schema)|truncate\s+table|delete\s+from\s+\w+\s*(?:;|$))/i },
  { risk: 'high', cat: 'process', why: 'kills processes by name', re: /\b(?:killall|pkill)\b|\btaskkill\b[^\n]*\/im\b|\bstop-process\b[^\n]*-name\b/i },

  // ---- medium
  { risk: 'medium', cat: 'process', why: 'terminates a process', re: /(?:^|[\s;&|])(?:kill|taskkill|stop-process)\b/i },
  { risk: 'medium', cat: 'delete', why: 'deletes files', re: /(?:^|[\s;&|(])(?:rm|unlink|del|erase|remove-item|ri|rmdir|rd|trash|trash-put|gio\s+trash)\b|\bos\.remove\b|\bfs\.unlink/i },
  { risk: 'medium', cat: 'overwrite', why: 'moves or overwrites files', re: /(?:^|[\s;&|])(?:mv|move|move-item|ren|rename|rename-item)\b|\bcp\b[^\n]*\s-[a-z]*f|\bcopy-item\b[^\n]*-force|\btruncate\b/i },
  { risk: 'medium', cat: 'network', why: 'sends data to or connects to a remote host', re: /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|socat)\b|\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|-d\s|-F\s|--upload-file|-T\s)|\bwget\b[^\n]*--post|\binvoke-(?:webrequest|restmethod)\b[^\n]*-method\s+(?:post|put|patch|delete)/i },
  { risk: 'medium', cat: 'git-remote', why: 'pushes to a git remote', re: /\bgit\s+push\b|\bgh\s+(?:pr\s+(?:create|merge|close)|issue\s+(?:create|close)|repo\s+(?:create|delete))\b/i },
  { risk: 'medium', cat: 'install', why: 'installs project dependencies', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|update|upgrade|remove|uninstall)\b|\bpip3?\s+install\b|\bpoetry\s+(?:add|install)\b|\buv\s+(?:pip\s+install|add)\b|\bbundle\s+install\b|\bcomposer\s+(?:install|require)\b/i },
  { risk: 'medium', cat: 'containers', why: 'runs containers', re: /\bdocker\s+(?:run|compose\s+up|stop|kill)\b|\bpodman\s+run\b/i },
  { risk: 'medium', cat: 'system-config', why: 'persists environment variables', re: /\bsetx\b|\[environment\]::setenvironmentvariable/i },
  { risk: 'medium', cat: 'scheduling', why: 'creates scheduled tasks', re: /\bcrontab\b(?!\s+-l)|\bschtasks\b[^\n]*\/create|\bregister-scheduledtask\b|\bat\s+\d/i },
  { risk: 'medium', cat: 'eval', why: 'evaluates dynamic code', re: /\beval\b|\binvoke-expression\b|\biex\b/i },
];

const SYSTEM_PROCESSES = /^(?:init|systemd|launchd|kernel_task|windowserver|loginwindow|explorer\.exe|csrss|csrss\.exe|winlogon|winlogon\.exe|wininit|wininit\.exe|lsass|lsass\.exe|services\.exe|smss\.exe|dwm\.exe|xorg|xwayland|gnome-shell|kwin_x11|kwin_wayland|plasmashell|sshd|dbus-daemon|finder)$/i;

export function isSystemProcess(name) {
  return SYSTEM_PROCESSES.test(String(name || '').trim());
}

export function defaultProtectedPaths(platform = process.platform, home = os.homedir()) {
  const common = [home, path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.aws'), path.join(home, '.kube'), path.join(home, '.config'), path.join(home, 'Documents'), path.join(home, 'Desktop'), path.join(home, 'Pictures')];
  if (platform === 'win32') {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    return [...common, 'C:\\', sys, 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Users', path.join(home, 'AppData')];
  }
  const unix = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/root', '/sbin', '/sys', '/usr', '/var', '/home', '/srv'];
  if (platform === 'darwin') unix.push('/System', '/Library', '/Applications', '/Users', '/private', path.join(home, 'Library'));
  return [...common, ...unix];
}

// Directories that hold user homes: protected themselves, never their subtree.
const HOME_CONTAINERS = new Set(['/home', '/users', '/Users', '/root', 'c:\\users']);

/**
 * Is `target` protected? Rules:
 *  - a protected path itself is always protected (deleting ~ or /etc);
 *  - ancestors of $HOME ("/", "/home", "C:\\Users") protect only themselves;
 *  - $HOME and folders inside it protect themselves, credential folders (~/.ssh…) their whole subtree;
 *  - system folders (/etc, /usr, C:\\Windows…) protect their whole subtree;
 *  - anything inside the temp directory is never protected.
 */
export function isProtectedPath(target, protectedPaths, { platform = process.platform } = {}) {
  if (!target) return false;
  const sep = platform === 'win32' ? '\\' : '/';
  const norm = (p) => {
    let r = path.resolve(expandPath(p));
    if (platform === 'win32') r = r.toLowerCase();
    const root = path.parse(r).root;
    return r === root ? r : r.replace(/[\\/]+$/, '');
  };
  const under = (child, parent) => child !== parent && child.startsWith(parent.endsWith(sep) || parent.endsWith('/') ? parent : parent + sep);
  const t = norm(target);
  const home = norm(os.homedir());
  for (const tmp of [os.tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/folders', '/var/folders']) {
    const n = norm(tmp);
    if (under(t, n)) return false;
  }
  for (const p of protectedPaths) {
    const pp = norm(p);
    if (t === pp) return true;
    if (HOME_CONTAINERS.has(pp)) continue;
    if (under(home, pp) || pp === home || under(pp, home)) {
      if (/[\\/]\.(?:ssh|gnupg|aws|kube)$/.test(pp) && under(t, pp)) return true;
      continue;
    }
    if (under(t, pp)) return true;
  }
  return false;
}

/** Split a shell command line into simple command segments (best effort, quote aware). */
export function splitCommands(cmd) {
  const segments = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>')) {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  segments.push(cur);
  // Also classify command substitutions $(...) and `...`
  const subs = [];
  for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) subs.push(m[1] ?? m[2]);
  return [...segments, ...subs].map((s) => s.trim()).filter(Boolean);
}

/** Tokenise a single simple command (handles quotes). */
export function tokenize(segment) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

const WRAPPERS = /^(?:bash|sh|zsh|dash|ksh|fish)$/i;

/** Extract the payload of `bash -c "..."`, `powershell -Command ...`, `cmd /c ...`. */
function innerCommand(tokens) {
  if (!tokens.length) return null;
  const exe = path.basename(tokens[0]).replace(/\.exe$/i, '').toLowerCase();
  if (WRAPPERS.test(exe)) {
    const i = tokens.findIndex((t) => /^-\w*c$/.test(t));
    if (i >= 0 && tokens[i + 1]) return tokens.slice(i + 1).join(' ');
  }
  if (exe === 'powershell' || exe === 'pwsh') {
    const i = tokens.findIndex((t) => /^-(?:c|command|encodedcommand|ec|e)$/i.test(t));
    if (i >= 0) {
      if (/^-(?:encodedcommand|ec|e)$/i.test(tokens[i])) {
        try {
          return Buffer.from(tokens[i + 1] || '', 'base64').toString('utf16le');
        } catch {
          return null;
        }
      }
      return tokens.slice(i + 1).join(' ');
    }
  }
  if (exe === 'cmd') {
    const i = tokens.findIndex((t) => /^\/[ck]$/i.test(t));
    if (i >= 0) return tokens.slice(i + 1).join(' ');
  }
  return null;
}

function stripPrefixes(tokens) {
  // env VAR=1 cmd, nohup cmd, time cmd, nice cmd, command cmd, exec cmd
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
    else if (/^(?:env|nohup|time|nice|ionice|command|exec|builtin|stdbuf|timeout|caffeinate)$/.test(t)) {
      i++;
      if (t === 'timeout' && tokens[i] && /^\d/.test(tokens[i])) i++;
    } else break;
  }
  return tokens.slice(i);
}

/**
 * Classify a shell command.
 * @param {string} command
 * @param {{protectedPaths?: string[], allowCommands?: string[], denyCommands?: string[], cwd?: string, platform?: string, depth?: number}} [opts]
 * @returns {Assessment}
 */
export function classifyCommand(command, opts = {}) {
  const { protectedPaths = defaultProtectedPaths(opts.platform), allowCommands = [], denyCommands = [], cwd = process.cwd(), depth = 0 } = opts;
  const text = String(command ?? '').trim();
  const res = { risk: 'safe', reasons: [], categories: [] };
  const bump = (risk, cat, why) => {
    if (riskRank(risk) > riskRank(res.risk)) res.risk = risk;
    if (cat && !res.categories.includes(cat)) res.categories.push(cat);
    if (why && !res.reasons.includes(why)) res.reasons.push(why);
  };
  if (!text) return res;

  for (const pat of denyCommands) {
    if (safeRegex(pat)?.test(text)) {
      bump('forbidden', 'policy', `matches denyCommands pattern ${pat}`);
      return res;
    }
  }
  if (allowCommands.some((pat) => safeRegex(pat)?.test(text))) {
    // Allow-listed commands are treated as low risk but still cannot bypass forbidden rules.
    const forbidden = RULES.filter((r) => r.risk === 'forbidden' && r.re.test(text));
    if (!forbidden.length) {
      bump('low', 'allow-listed', 'matches allowCommands');
      return res;
    }
  }

  for (const rule of RULES) {
    if (rule.re.test(text)) bump(rule.risk, rule.cat, rule.why);
  }

  for (const seg of splitCommands(text)) {
    const tokens = stripPrefixes(tokenize(seg));
    if (!tokens.length) continue;
    const inner = innerCommand(tokens);
    if (inner && depth < 3) {
      const sub = classifyCommand(inner, { ...opts, depth: depth + 1 });
      if (riskRank(sub.risk) > riskRank('safe')) sub.reasons.forEach((r, i) => bump(sub.risk, sub.categories[i] ?? sub.categories[0], r));
      if (sub.risk === 'safe') continue;
      bump(sub.risk);
      continue;
    }
    const exe = path.basename(tokens[0]).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
    let segRisk = 'low';
    if (READ_ONLY.has(exe) && !CONDITIONAL.has(exe)) segRisk = 'safe';
    else if (CONDITIONAL.has(exe)) {
      segRisk = conditionalRisk(exe, tokens);
      if (exe === 'find' && segRisk === 'medium') bump('medium', 'delete', 'find with -delete/-exec');
    }
    // Output redirection makes otherwise read-only commands write files.
    if (/(?:^|[^>2&])>{1,2}\s*(?!&|\/dev\/null|nul\b|\$null)\S/i.test(seg)) {
      segRisk = maxRisk(segRisk, 'low');
      const m = seg.match(/(?:^|[^>2&])>\s*(?!>)([^\s;&|]+)/);
      if (m && !/^(?:\/dev\/null|nul|\$null)$/i.test(m[1])) {
        const target = resolveArg(m[1], cwd);
        if (target && isProtectedPath(target, protectedPaths, opts)) bump('critical', 'overwrite', `overwrites protected path ${m[1]}`);
        else if (target && fileExists(target)) bump('medium', 'overwrite', `overwrites existing file ${m[1]}`);
      }
    }
    bump(segRisk);

    // Path-aware escalation for destructive verbs.
    if (/^(?:rm|del|erase|rd|rmdir|remove-item|ri|unlink|shred|mv|move|move-item|truncate|trash|trash-put)$/.test(exe)) {
      const targets = tokens.slice(1).filter((t) => !t.startsWith('-') && !(opts.platform === 'win32' && /^\/[a-z]{1,2}$/i.test(t)));
      for (const t of targets) {
        if (t === '*' || t === '.' || t === '..' || t === '~' || /^\.{1,2}[\\/]?\*?$/.test(t)) {
          bump('high', 'mass-delete', `operates on "${t}"`);
          continue;
        }
        const abs = resolveArg(t, cwd);
        if (abs && isProtectedPath(abs, protectedPaths, opts)) bump('critical', 'protected-path', `targets protected path ${t}`);
      }
    }
  }
  return res;
}

function conditionalRisk(exe, tokens) {
  const args = tokens.slice(1);
  const sub = args.find((a) => !a.startsWith('-')) ?? args[0];
  switch (exe) {
    case 'git':
      return sub && SAFE_SUBCOMMANDS.git.has(sub) && !args.some((a) => /^(?:-d|-D|--delete|--set-upstream-to|--unset|--add|--replace-all|drop|clear|pop|apply)$/.test(a)) ? 'safe' : 'low';
    case 'npm': case 'pip': case 'pip3': case 'cargo': case 'go':
      return sub && SAFE_SUBCOMMANDS[exe].has(sub) ? 'safe' : 'low';
    case 'node': case 'python': case 'python3': case 'java':
      return args.length === 1 && /^(?:-v|--version|-V)$/.test(args[0]) ? 'safe' : 'low';
    case 'find':
      return args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a)) ? 'medium' : 'safe';
    case 'sed':
      return args.some((a) => /^-[a-z]*i/.test(a) || a.startsWith('--in-place')) ? 'low' : 'safe';
    case 'awk':
      return args.some((a) => /system\s*\(|>\s*"/.test(a)) ? 'low' : 'safe';
    case 'tee':
      return 'low';
    case 'xargs':
      return 'low';
    default:
      return 'low';
  }
}

function resolveArg(arg, cwd) {
  if (!arg || /[*?]/.test(arg.replace(/\*$/, ''))) return null;
  const clean = arg.replace(/^["']|["']$/g, '').replace(/[\\/]\*$/, '');
  if (!clean) return null;
  try {
    return path.resolve(cwd, expandPath(clean));
  } catch {
    return null;
  }
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const regexCache = new Map();
function safeRegex(pat) {
  if (regexCache.has(pat)) return regexCache.get(pat);
  let re = null;
  try {
    re = new RegExp(pat, 'i');
  } catch {
    re = null;
  }
  regexCache.set(pat, re);
  return re;
}

// ---------------------------------------------------------------- GUI actions

const DESTRUCTIVE_UI_TEXT = /\b(?:delete|remove|erase|format|wipe|overwrite|replace|uninstall|discard|don'?t save|do not save|empty trash|reset|factory|destroy|purge|revoke|terminate|force quit|end task|permanently)\b/i;
const CONFIRM_UI_TEXT = /\b(?:install|allow|grant|authorize|trust|enable|purchase|buy|pay|send|submit|publish|accept|agree|sign in|log in)\b/i;
const TERMINAL_WINDOW = /\b(?:terminal|xterm|urxvt|rxvt|konsole|alacritty|kitty|wezterm|tilix|terminator|gnome-terminal|xfce4-terminal|iterm2?|hyper|warp|windowsterminal|cmd\.exe|command prompt|powershell|pwsh|conhost|mintty|git bash|tabby|foot)\b/i;

export function isTerminalWindow(win) {
  if (!win) return false;
  return TERMINAL_WINDOW.test(`${win.app ?? ''} ${win.className ?? ''} ${win.title ?? ''}`);
}

/** Risk of clicking/invoking a UI element with the given visible label. */
export function classifyUiTarget(label) {
  const res = { risk: 'low', reasons: [], categories: [] };
  if (!label) return res;
  if (DESTRUCTIVE_UI_TEXT.test(label)) {
    res.risk = 'high';
    res.categories.push('destructive-ui');
    res.reasons.push(`target "${String(label).slice(0, 60)}" looks destructive`);
  } else if (CONFIRM_UI_TEXT.test(label)) {
    res.risk = 'medium';
    res.categories.push('consequential-ui');
    res.reasons.push(`target "${String(label).slice(0, 60)}" has external or persistent effects`);
  }
  return res;
}

const RISKY_HOTKEYS = [
  { re: /^(?:ctrl\+alt\+delete|ctrl\+alt\+del)$/, risk: 'high', why: 'system security screen' },
  { re: /^(?:meta\+l|ctrl\+meta\+q|ctrl\+alt\+l)$/, risk: 'high', why: 'locks the session (agent loses control)' },
  { re: /^(?:ctrl\+alt\+backspace|ctrl\+alt\+(?:f[1-9]|f1[0-2]))$/, risk: 'high', why: 'kills or switches the display session' },
  { re: /^(?:shift\+meta\+q|alt\+shift\+meta\+q|ctrl\+alt\+meta\+(?:delete|eject))$/, risk: 'critical', why: 'logs out / shuts down' },
  { re: /^(?:alt\+f4|meta\+q|ctrl\+q|ctrl\+w|meta\+w|ctrl\+shift\+w|meta\+shift\+w)$/, risk: 'medium', why: 'closes a window or application' },
  { re: /^(?:shift\+delete|meta\+backspace|meta\+delete)$/, risk: 'high', why: 'deletes (possibly permanently)' },
];

export function classifyHotkey(comboString) {
  const res = { risk: 'low', reasons: [], categories: [] };
  for (const h of RISKY_HOTKEYS) {
    if (h.re.test(comboString)) {
      res.risk = maxRisk(res.risk, h.risk);
      res.reasons.push(`${comboString}: ${h.why}`);
      res.categories.push('hotkey');
    }
  }
  return res;
}

/** Code run inside an application's scripting engine (Blender Python, Godot, …). */
export function classifyScript(code, opts = {}) {
  const res = { risk: 'medium', reasons: ['runs code inside an application'], categories: ['app-script'] };
  const text = String(code ?? '');
  if (/\b(?:shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|Path\([^)]*\)\.unlink|rmtree|DirAccess\.remove|File\.Delete|Directory\.Delete|fs\.rm|fs\.unlink|removeItem|deleteFile)\b/.test(text)) {
    res.risk = 'high';
    res.reasons.push('deletes files');
    res.categories.push('delete');
  }
  if (/\b(?:subprocess|os\.system|os\.popen|OS\.execute|Process\.Start|child_process|system\(|exec\()/i.test(text)) {
    res.risk = 'high';
    res.reasons.push('spawns external processes');
    res.categories.push('process');
    const cmds = [...text.matchAll(/(?:os\.system|subprocess\.\w+)\(\s*\[?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const c of cmds) {
      const sub = classifyCommand(c, opts);
      if (riskRank(sub.risk) > riskRank(res.risk)) {
        res.risk = sub.risk;
        res.reasons.push(...sub.reasons);
      }
    }
  }
  return res;
}
