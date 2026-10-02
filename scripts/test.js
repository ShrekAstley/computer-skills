#!/usr/bin/env node
// Portable test launcher: expands test directories into files (node --test glob/dir
// handling differs between Node 18, 20 and 22, and Windows shells don't expand globs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const files = [];
for (const d of dirs.length ? dirs : ['test/unit']) {
  const st = fs.statSync(d);
  if (st.isFile()) files.push(d);
  else for (const f of fs.readdirSync(d).sort()) if (f.endsWith('.test.js')) files.push(path.join(d, f));
}
const r = spawnSync(process.execPath, ['--test', ...flags, ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
