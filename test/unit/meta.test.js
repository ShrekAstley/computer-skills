import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../../src/version.js';
import { PACKAGE_ROOT } from '../../src/core/paths.js';
import { installClientConfig } from '../../src/install/client-config.js';
import { tmpDir } from '../helpers.js';

const read = (p) => JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, p), 'utf8'));

test('versions are in sync', () => {
  assert.equal(read('package.json').version, VERSION);
  assert.equal(read('.claude-plugin/plugin.json').version, VERSION);
  const mp = read('.claude-plugin/marketplace.json');
  assert.equal(mp.plugins.find((p) => p.name === 'computer-skills').version, VERSION);
});

test('plugin MCP config points at the CLI', () => {
  const mcp = read('.mcp.json');
  const srv = mcp.mcpServers['computer-skills'];
  assert.equal(srv.command, 'node');
  assert.ok(srv.args[0].includes('${CLAUDE_PLUGIN_ROOT}/bin/computer-skills.js'));
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'bin', 'computer-skills.js')));
});

test('skills, agents and commands have valid frontmatter', () => {
  const files = [
    ...fs.readdirSync(path.join(PACKAGE_ROOT, 'skills')).map((d) => `skills/${d}/SKILL.md`),
    ...fs.readdirSync(path.join(PACKAGE_ROOT, 'agents')).map((f) => `agents/${f}`),
    ...fs.readdirSync(path.join(PACKAGE_ROOT, 'commands')).map((f) => `commands/${f}`),
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, f), 'utf8');
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, `${f} has frontmatter`);
    assert.match(m[1], /^description: .{20,}/m, `${f} has a description`);
    if (f.startsWith('skills/') || f.startsWith('agents/')) assert.match(m[1], /^name: [a-z0-9-]+$/m, `${f} has a name`);
  }
});

test('documentation references only existing tools', async () => {
  const { ALL_TOOLS } = await import('../../src/tools/index.js');
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  const { CHECK_TYPES } = await import('../../src/verify/checks.js');
  const argNames = new Set([...ALL_TOOLS.flatMap((t) => Object.keys(t.inputSchema.properties || {})), ...Object.keys(CHECK_TYPES), 'ui_map']);
  const docs = ['skills/computer-skills/SKILL.md', ...fs.readdirSync(path.join(PACKAGE_ROOT, 'skills/computer-skills/references')).map((f) => `skills/computer-skills/references/${f}`), 'README.md', 'docs/TOOLS.md'];
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, doc), 'utf8');
    for (const m of text.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
      const id = m[1];
      if (argNames.has(id) || !/^(env|terminal|screen|ui|input|workflow)_/.test(id)) continue;
      assert.ok(names.has(id), `${doc} mentions unknown tool ${id}`);
    }
  }
});

test('client config installer merges without clobbering', async () => {
  const home = tmpDir();
  const cwd = tmpDir();
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  const r = await installClientConfig({ target: 'cursor', scope: 'user', home, cwd });
  assert.equal(r.applied, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers.other);
  assert.ok(cfg.mcpServers['computer-skills'].args[0].endsWith('computer-skills.js'));
  assert.ok(fs.existsSync(path.join(home, '.cursor', 'mcp.json.bak')));

  const oc = await installClientConfig({ target: 'opencode', scope: 'project', home, cwd });
  assert.equal(oc.applied, true);
  const ocCfg = JSON.parse(fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8'));
  assert.equal(ocCfg.mcp['computer-skills'].type, 'local');
  assert.equal(ocCfg.mcp['computer-skills'].command.at(-1), 'serve');

  fs.writeFileSync(path.join(cwd, '.mcp.json'), '{\n // keep me\n "mcpServers": {}\n}');
  const cl = await installClientConfig({ target: 'claude', scope: 'project', home, cwd });
  assert.equal(cl.applied, false, 'files with comments are not rewritten');
  assert.ok(cl.config.mcpServers['computer-skills']);
});
