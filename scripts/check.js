#!/usr/bin/env node
// Zero-dependency static checks: syntax, unused imports, JSON manifests, generated docs, example workflows.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`✘ ${msg}`);
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = ['bin', 'src', 'scripts', 'test'].flatMap((d) => walk(path.join(root, d)));
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax: ${path.relative(root, f)}\n${r.stderr}`);
  // Unused named imports
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"];?$/gm)) {
    const uses = src.match(new RegExp(`\\b${m[1].replace(/\$/g, '\\$')}\\b`, 'g'))?.length ?? 0;
    if (uses < 2) fail(`unused import "${m[1]}" in ${path.relative(root, f)}`);
  }
  for (const m of src.matchAll(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"];?$/gm)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      const uses = src.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g'))?.length ?? 0;
      const reexported = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(src);
      if (uses < 2 && !reexported) fail(`unused import "${name}" in ${path.relative(root, f)}`);
    }
  }
}

for (const j of ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.mcp.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, j), 'utf8'));
  } catch (err) {
    fail(`${j}: ${err.message}`);
  }
}

// Platform helper scripts: JXA is JavaScript (node can parse it); PowerShell is parsed when pwsh is available.
{
  const jxa = path.join(root, 'src', 'platform', 'helpers', 'macos_helper.jxa');
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cs-jxa-')), 'helper.js');
  fs.copyFileSync(jxa, tmp);
  const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (r.status !== 0) fail(`syntax: macos_helper.jxa\n${r.stderr}`);
  const pwsh = ['pwsh', 'pwsh.exe', 'powershell.exe'].find((c) => spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0);
  if (pwsh) {
    const ps1 = path.join(root, 'src', 'platform', 'helpers', 'windows_helper.ps1').replace(/'/g, "''");
    const cmd = `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${ps1}',[ref]$t,[ref]$e);if($e.Count){$e|%{ "line $($_.Extent.StartLineNumber): $($_.Message)" };exit 1}`;
    const p = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
    if (p.status !== 0) fail(`syntax: windows_helper.ps1\n${p.stdout}${p.stderr}`);
  }
}

const docs = spawnSync(process.execPath, [path.join(root, 'scripts', 'gen-docs.js'), '--check'], { encoding: 'utf8' });
if (docs.status !== 0) fail(docs.stderr.trim());

const wf = spawnSync(process.execPath, [path.join(root, 'bin', 'computer-skills.js'), 'workflows', 'validate', path.join(root, 'examples', 'workflows')], {
  encoding: 'utf8',
  env: { ...process.env, COMPUTER_SKILLS_HOME: fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'cs-check-')) },
});
if (wf.status !== 0) fail(`example workflows:\n${wf.stdout}${wf.stderr}`);

if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
console.log(`✔ ${files.length} files checked; manifests, docs and example workflows OK`);
