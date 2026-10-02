import fsp from 'node:fs/promises';
import { defineTool } from './registry.js';
import { assessment } from './common.js';
import { SECTIONS } from '../context/environment.js';
import { classifyCommand } from '../safety/classifier.js';
import { DECISIONS } from '../safety/policy.js';
import { ToolError, ErrorCode } from '../core/errors.js';
import { need } from './terminal.js';

export const envInspect = defineTool({
  name: 'env_inspect',
  title: 'Inspect the computer',
  description:
    'Learn about the computer before acting: OS/hardware (system), display server (session), monitors (displays), shells, installed developer tools with versions (tools), ' +
    'what computer-control features work here and what to install if not (capabilities), important folders (dirs), installed GUI apps (apps), top processes (processes), ' +
    'and the safety level (safety). Results are cached on disk and reused across sessions; pass refresh=true after installing things.',
  inputSchema: {
    type: 'object',
    properties: {
      sections: { type: 'array', items: { type: 'string', enum: [...SECTIONS, 'all'] }, description: 'Default: system, session, displays, shells, tools, capabilities, dirs, safety.' },
      refresh: { type: 'boolean' },
    },
  },
  readOnly: true,
  async handler(a, rt) {
    return rt.environment.inspect({ sections: a.sections, refresh: a.refresh });
  },
});

export const safetyTool = defineTool({
  name: 'safety',
  title: 'Safety policy',
  description:
    'Inspect the safety policy: "status" (level, what each risk level requires, kill switch, config sources), "check" (dry-run risk classification of a `command` — nothing is executed), ' +
    '"audit" (recent policy decisions), "stop" (engage the kill switch: all actions are refused until the user resumes). The level itself can only be changed by the user.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'check', 'audit', 'stop'] },
      command: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      reason: { type: 'string' },
    },
    required: ['action'],
  },
  readOnly: true, // never escalates; "stop" only restricts
  async handler(a, rt) {
    const p = rt.policy;
    switch (a.action) {
      case 'status':
        return {
          level: p.level,
          matrix: DECISIONS[p.level],
          levels: Object.keys(DECISIONS),
          kill_switch: { engaged: p.isStopped(), file: rt.paths.stopFile },
          failsafe_corner: !!rt.config.safety.failsafeCorner,
          blocked_apps: rt.config.safety.blockedApps,
          extra_protected_paths: rt.config.safety.protectedPaths,
          config_sources: rt.config._sources,
          how_to_change: 'Set COMPUTER_SKILLS_LEVEL (restricted|normal|trusted) in the MCP server env, or "safety.level" in ~/.computer-skills/config.json.',
        };
      case 'check': {
        need(a, 'command');
        const r = classifyCommand(a.command, p.classifierOptions({ cwd: rt.paths.project.root }));
        return { command: a.command, ...r, decision: p.decide(r.risk), level: p.level };
      }
      case 'audit': {
        const file = rt.paths.logs + '/audit.jsonl';
        let lines = [];
        try {
          lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
        } catch {
          /* empty */
        }
        return { entries: lines.slice(-(a.limit ?? 30)).map((l) => JSON.parse(l)) };
      }
      case 'stop':
        p.setStopped(true, a.reason ?? 'engaged by agent');
        return { stopped: true, resume: 'The user resumes with `computer-skills resume` or by deleting ' + rt.paths.stopFile };
      default:
        throw new ToolError(ErrorCode.INVALID_ARGUMENT, `Unknown action ${a.action}`);
    }
  },
});

export { assessment };
