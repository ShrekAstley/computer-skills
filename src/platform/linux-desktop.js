import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Parse a freedesktop .desktop file's [Desktop Entry] group. */
export function parseDesktopEntry(text) {
  const out = {};
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in out)) out[key] = value; // first wins; localized keys like Name[de] are separate
  }
  return out;
}

/** Split an Exec line into argv, dropping field codes (%f %U …) as the spec requires. */
export function parseExec(exec) {
  const args = [];
  let cur = '';
  let quoted = false;
  let had = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (quoted) {
      if (c === '\\' && i + 1 < exec.length) {
        cur += exec[++i];
      } else if (c === '"') quoted = false;
      else cur += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      had = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || had) args.push(cur);
      cur = '';
      had = false;
      continue;
    }
    cur += c;
  }
  if (cur || had) args.push(cur);
  return args
    .filter((a) => !/^%[fFuUdDnNickvm]$/.test(a))
    .map((a) => a.replace(/%%/g, '%'));
}

export function desktopDirs(env = process.env) {
  const home = os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dirs = [
    path.join(dataHome, 'applications'),
    ...dataDirs.map((d) => path.join(d, 'applications')),
    '/var/lib/flatpak/exports/share/applications',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/snapd/desktop/applications',
  ];
  return [...new Set(dirs)];
}

/** Enumerate installed GUI applications from .desktop files. */
export async function listDesktopApps(env = process.env) {
  const seen = new Map();
  for (const dir of desktopDirs(env)) {
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.desktop')) continue;
      const id = f.slice(0, -'.desktop'.length);
      if (seen.has(id)) continue; // earlier dirs (user) override later (system)
      let entry;
      try {
        entry = parseDesktopEntry(await fsp.readFile(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      if (entry.Type && entry.Type !== 'Application') continue;
      if (!entry.Exec || !entry.Name) continue;
      seen.set(id, {
        name: entry.Name,
        id,
        exec: entry.Exec,
        path: path.join(dir, f),
        source: dir.includes('flatpak') ? 'flatpak' : dir.includes('snapd') ? 'snap' : 'desktop-entry',
        wmClass: entry.StartupWMClass,
        categories: entry.Categories ? entry.Categories.split(';').filter(Boolean) : [],
        hidden: entry.NoDisplay === 'true' || entry.Hidden === 'true',
        genericName: entry.GenericName,
        keywords: entry.Keywords,
      });
    }
  }
  return [...seen.values()];
}

/** Parse `wmctrl -lpGx` output. */
export function parseWmctrl(text) {
  const wins = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s?(.*)$/i);
    if (!m) continue;
    const [, id, desktop, pid, x, y, w, h, wmClass, , title] = m;
    const [instance, cls] = wmClass.split('.');
    wins.push({
      id: normalizeXid(id),
      title: title ?? '',
      app: cls || instance || '',
      className: wmClass,
      pid: Number(pid) || undefined,
      x: Number(x),
      y: Number(y),
      width: Number(w),
      height: Number(h),
      workspace: Number(desktop),
      sticky: desktop === '-1',
    });
  }
  return wins.filter((w) => w.workspace !== -1 || w.width > 0);
}

export function normalizeXid(id) {
  const n = typeof id === 'number' ? id : String(id).startsWith('0x') ? parseInt(id, 16) : parseInt(id, 10);
  return '0x' + n.toString(16).padStart(8, '0');
}

/** Flatten a sway get_tree into windows. */
export function parseSwayTree(tree) {
  const wins = [];
  const walk = (node, workspace) => {
    if (node.type === 'workspace') workspace = node.name;
    if ((node.type === 'con' || node.type === 'floating_con') && node.pid) {
      wins.push({
        id: String(node.id),
        title: node.name ?? '',
        app: node.app_id || node.window_properties?.class || '',
        className: node.window_properties?.class || node.app_id || '',
        pid: node.pid,
        x: node.rect.x,
        y: node.rect.y,
        width: node.rect.width,
        height: node.rect.height,
        focused: !!node.focused,
        workspace,
      });
    }
    for (const c of [...(node.nodes || []), ...(node.floating_nodes || [])]) walk(c, workspace);
  };
  walk(tree, undefined);
  return wins;
}

export function parseHyprClients(clients) {
  return clients
    .filter((c) => c.mapped !== false)
    .map((c) => ({
      id: c.address,
      title: c.title ?? '',
      app: c.class || c.initialClass || '',
      className: c.class,
      pid: c.pid,
      x: c.at?.[0] ?? 0,
      y: c.at?.[1] ?? 0,
      width: c.size?.[0] ?? 0,
      height: c.size?.[1] ?? 0,
      focused: c.focusHistoryID === 0,
      workspace: c.workspace?.name,
    }));
}

/** Parse `xwininfo -root -tree` into a map of window id → absolute geometry. */
export function parseXwininfoTree(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(0x[0-9a-f]+)\b.*?\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+(-?\d+)\+(-?\d+)\s*$/i);
    if (m) map.set(parseInt(m[1], 16), { x: Number(m[4]), y: Number(m[5]), width: Number(m[2]), height: Number(m[3]) });
  }
  return map;
}
