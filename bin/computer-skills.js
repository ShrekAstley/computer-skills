#!/usr/bin/env node
// computer-skills CLI: MCP server, diagnostics, direct tool calls, workflow management.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write(`computer-skills requires Node.js 18 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}

const { createRuntime, serve, VERSION } = await import('../src/index.js');
const { validateWorkflow, normalizeWorkflow } = await import('../src/workflow/schema.js');
const { readJson, listFiles, writeJsonAtomic } = await import('../src/core/fsutil.js');
const { installClientConfig } = await import('../src/install/client-config.js');
const { statePaths } = await import('../src/core/paths.js');
const { DEFAULT_CONFIG } = await import('../src/core/config.js');

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'serve';
const flags = parseFlags(argv);

const HELP = `computer-skills ${VERSION}

Usage: computer-skills <command> [options]

  serve                       Run the MCP server on stdio (default)
  doctor                      Check what works on this computer and what to install
  tools                       List tools with descriptions
  call <tool> ['<json>']      Invoke a tool directly (asks before risky actions; --yes to approve)
  env [section...]            Inspect the environment (system, displays, shells, tools, apps, ...)
  workflows list|show <id>|validate [path]|export <id> [file]|import <file> [--project]
  stop [reason] | resume      Engage / release the kill switch
  audit [n]                   Show the last n safety decisions
  config show|init|path       Show the effective config, write a starter config, print its path
  install-config --target claude|cursor|opencode [--scope user|project] [--dry-run]
                              Register the MCP server in a client's config
  version

Environment: COMPUTER_SKILLS_LEVEL=restricted|normal|trusted, COMPUTER_SKILLS_HOME, COMPUTER_SKILLS_LOG_LEVEL=debug`;

try {
  await main();
} catch (err) {
  const e = err?.toJSON ? err.toJSON() : { message: err?.message ?? String(err) };
  process.stderr.write(`error: ${e.message}${e.hint ? `\nhint: ${e.hint}` : ''}\n`);
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case 'serve':
      await serve();
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'doctor':
      return doctor();
    case 'tools': {
      const rt = await quietRuntime();
      for (const t of rt.host.listTools()) console.log(`${t.name.padEnd(18)} ${t.title}\n${wrap(t.description, 19)}\n`);
      return rt.dispose();
    }
    case 'call':
      return callTool();
    case 'env': {
      const rt = await quietRuntime();
      const sections = flags._.length ? flags._ : undefined;
      print(await rt.environment.inspect({ sections, refresh: !!flags.refresh }));
      return rt.dispose();
    }
    case 'workflows':
      return workflows();
    case 'stop': {
      const rt = await quietRuntime();
      rt.policy.setStopped(true, flags._.join(' ') || 'manual (CLI)');
      console.log(`Kill switch engaged (${rt.paths.stopFile}). All actions are refused until \`computer-skills resume\`.`);
      return rt.dispose();
    }
    case 'resume': {
      const rt = await quietRuntime();
      rt.policy.setStopped(false);
      console.log('Kill switch released.');
      return rt.dispose();
    }
    case 'audit': {
      const p = path.join(statePaths().logs, 'audit.jsonl');
      const n = Number(flags._[0] ?? 30);
      const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').slice(-n) : [];
      for (const l of lines) {
        const r = JSON.parse(l);
        console.log(`${r.t}  ${r.decision.padEnd(22)} ${r.risk.padEnd(9)} ${r.tool.padEnd(16)} ${r.summary}`);
      }
      return;
    }
    case 'config':
      return configCmd();
    case 'install-config': {
      const res = await installClientConfig({ target: flags.target, scope: flags.scope ?? 'user', dryRun: !!flags['dry-run'], serverPath: flags['server-path'], name: flags.name });
      print(res);
      return;
    }
    default:
      console.error(HELP);
      process.exit(2);
  }
}

async function quietRuntime() {
  const { Logger } = await import('../src/core/logger.js');
  return createRuntime({ logger: new Logger({ level: process.env.COMPUTER_SKILLS_LOG_LEVEL || 'warn', stderr: true }) });
}

async function doctor() {
  const rt = await quietRuntime();
  const env = await rt.environment.inspect({ sections: ['system', 'session', 'displays', 'shells', 'capabilities', 'safety'], refresh: true });
  const ok = (b) => (b ? '\x1b[32m✔\x1b[0m' : '\x1b[33m✘\x1b[0m');
  console.log(`computer-skills ${VERSION} — ${env.system.os} ${env.system.release} (${env.system.arch}), Node ${process.version}`);
  console.log(`backend: ${env.session.backend}${env.session.session ? ` (${env.session.session})` : ''}`);
  console.log(`displays: ${Array.isArray(env.displays) ? env.displays.map((d) => `${d.width}x${d.height}${d.primary ? '*' : ''}`).join(', ') || 'none' : env.displays.error}`);
  console.log(`shells: ${env.shells.available.map((s) => s.name).join(', ')} (default ${env.shells.default})`);
  console.log(`safety level: ${env.safety.level}${env.safety.stopped ? '  [KILL SWITCH ENGAGED]' : ''}`);
  console.log(`state dir: ${rt.paths.home}`);
  console.log('\ncapabilities:');
  let missing = 0;
  for (const [k, v] of Object.entries(env.capabilities || {})) {
    if (!v || typeof v !== 'object') continue;
    if (!v.available) missing++;
    console.log(`  ${ok(v.available)} ${k.padEnd(14)} ${v.method ?? ''}${v.hint ? `  — ${v.hint}` : ''}`);
  }
  console.log(`  ${ok(rt.ocr.available())} ${'ocr'.padEnd(14)} ${rt.ocr.engines().join(', ') || 'install tesseract (or use macOS/Windows native OCR)'}`);
  const wf = await rt.workflows.loadAll({ fresh: true });
  console.log(`\nworkflows: ${wf.size} available${rt.workflows.problems?.length ? `, ${rt.workflows.problems.length} invalid file(s)` : ''}`);
  for (const p of rt.workflows.problems || []) console.log(`  ✘ ${p.file}: ${p.error}`);
  console.log(missing ? `\n${missing} capability group(s) unavailable — the agent will fall back to other methods where possible.` : '\nAll capability groups available.');
  await rt.dispose();
}

async function callTool() {
  const name = flags._[0];
  if (!name) throw new Error('usage: computer-skills call <tool> \'{"arg": "value"}\'');
  const args = flags._[1] ? JSON.parse(flags._[1]) : {};
  const rt = await quietRuntime();
  const elicit = async (message) => {
    if (flags.yes) return 'accept';
    if (!process.stdin.isTTY) return 'unsupported';
    console.error(`\n${message}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise((r) => rl.question('Approve? [y/N] ', r));
    rl.close();
    return /^y(es)?$/i.test(answer.trim()) ? 'accept' : 'decline';
  };
  try {
    const res = await rt.host.invoke(name, args, { via: 'cli', elicit });
    if (res?.__image) {
      const out = flags.image ?? path.join(rt.paths.screenshots, `cli-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, res.__image);
      delete res.__image;
      res.image_file = out;
    }
    print(res);
  } finally {
    await rt.dispose();
  }
}

async function workflows() {
  const sub = flags._[0] ?? 'list';
  const rt = await quietRuntime();
  try {
    switch (sub) {
      case 'list': {
        const all = await rt.workflows.loadAll({ fresh: true });
        for (const w of all.values()) console.log(`${w.id.padEnd(42)} v${String(w.version).padEnd(3)} ${w._scope.padEnd(8)} runs:${w.stats.runs} ok:${w.stats.successes}  ${w.name}`);
        for (const p of rt.workflows.problems || []) console.log(`INVALID ${p.file}: ${p.error}`);
        break;
      }
      case 'show':
        print(await rt.workflows.get(flags._[1]));
        break;
      case 'validate': {
        const target = path.resolve(flags._[1] ?? rt.paths.workflows);
        const files = fs.statSync(target).isDirectory() ? await listFiles(target, '.json') : [target];
        let bad = 0;
        for (const f of files) {
          try {
            normalizeWorkflow(validateWorkflow(await readJson(f)));
            console.log(`ok    ${f}`);
          } catch (err) {
            bad++;
            console.log(`FAIL  ${f}: ${err.message}`);
          }
        }
        if (bad) process.exitCode = 1;
        break;
      }
      case 'export': {
        const wf = await rt.workflows.get(flags._[1]);
        const json = JSON.stringify(wf, null, 2);
        if (flags._[2]) fs.writeFileSync(flags._[2], json + '\n');
        else console.log(json);
        break;
      }
      case 'import': {
        const wf = await readJson(path.resolve(flags._[1]));
        print(await rt.workflows.save(wf, { scope: flags.project ? 'project' : 'user', changeNote: 'imported' }));
        break;
      }
      default:
        throw new Error(`unknown workflows subcommand ${sub}`);
    }
  } finally {
    await rt.dispose();
  }
}

async function configCmd() {
  const sub = flags._[0] ?? 'show';
  const p = statePaths();
  if (sub === 'path') return console.log(p.config);
  if (sub === 'init') {
    if (fs.existsSync(p.config) && !flags.force) throw new Error(`${p.config} exists (use --force to overwrite)`);
    await writeJsonAtomic(p.config, { safety: { level: 'normal', blockedApps: [], protectedPaths: [], allowCommands: [], denyCommands: [], failsafeCorner: true }, screen: { maxWidth: DEFAULT_CONFIG.screen.maxWidth }, ocr: { engine: 'auto', language: 'eng' } });
    return console.log(`wrote ${p.config}`);
  }
  const rt = await quietRuntime();
  const { _paths, ...cfg } = rt.config;
  print(cfg);
  await rt.dispose();
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (args[i + 1] && !args[i + 1].startsWith('--') && ['target', 'scope', 'server-path', 'name', 'image'].includes(k)) out[k] = args[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function wrap(text, indent) {
  const width = 100;
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).length > width - indent) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ' '.repeat(indent) + l).join('\n');
}

export const __filename = fileURLToPath(import.meta.url);
