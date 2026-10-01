import path from 'node:path';
import { loadConfig } from './core/config.js';
import { statePaths, projectPaths, BUILTIN_WORKFLOWS } from './core/paths.js';
import { Logger } from './core/logger.js';
import { SafetyPolicy } from './safety/policy.js';
import { createBackend, osName } from './platform/index.js';
import { ScreenService } from './screen/capture.js';
import { OcrService } from './screen/ocr.js';
import { InputService } from './ui/input.js';
import { UiService } from './ui/service.js';
import { AdapterRegistry } from './apps/registry.js';
import { AppManager } from './apps/manager.js';
import { SessionManager } from './terminal/sessions.js';
import { ProcessManager } from './terminal/processes.js';
import { WorkflowStore } from './workflow/store.js';
import { AppProfiles } from './workflow/profiles.js';
import { WorkflowRecorder } from './workflow/recorder.js';
import { WorkflowRunner } from './workflow/runner.js';
import { EnvironmentContext } from './context/environment.js';
import { ToolHost } from './tools/registry.js';
import { ALL_TOOLS, SERVER_INSTRUCTIONS } from './tools/index.js';
import { checkContext } from './tools/verify.js';
import { diagnose } from './verify/diagnose.js';
import { McpServer } from './mcp/server.js';

export { VERSION } from './version.js';

/**
 * Wire every service together. Everything the tools need hangs off the
 * returned runtime object `rt`, which keeps services swappable in tests
 * (e.g. a fake backend).
 *
 * @param {{env?: object, backend?: object, logger?: Logger, tools?: object[]}} [opts]
 */
export async function createRuntime(opts = {}) {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadConfig(env);
  const paths = { ...statePaths(env), project: projectPaths(env) };
  const logger =
    opts.logger ??
    new Logger({
      level: config.logging.level,
      stderr: config.logging.stderr !== false,
      file: config.logging.file ? path.join(paths.logs, 'server.log') : null,
    });

  const rt = { config, paths, logger, os: osName() };
  rt.policy = new SafetyPolicy({ config, logger, auditFile: path.join(paths.logs, 'audit.jsonl'), stopFile: paths.stopFile });
  rt.backend = opts.backend ?? createBackend({ config, logger, paths });
  rt.screen = new ScreenService({ backend: rt.backend, config, paths, logger });
  rt.ocr = new OcrService({ backend: rt.backend, screen: rt.screen, config, paths, logger });
  rt.input = new InputService({ backend: rt.backend, config, logger });
  rt.ui = new UiService({ backend: rt.backend, screen: rt.screen, ocr: rt.ocr, input: rt.input, config, logger });
  rt.adapters = new AdapterRegistry();
  await rt.adapters.loadUserAdapters(path.join(paths.home, 'adapters'), logger);
  rt.apps = new AppManager({ backend: rt.backend, adapters: rt.adapters, config, paths, logger });
  rt.sessions = new SessionManager({ config, logger });
  rt.processes = new ProcessManager({ config, paths, logger });
  rt.workflows = new WorkflowStore({
    userDir: paths.workflows,
    projectDir: paths.project.workflows,
    extraDirs: config.workflows?.extraDirs ?? [],
    builtinDir: opts.builtinWorkflows === false ? undefined : BUILTIN_WORKFLOWS,
    historyDir: paths.history,
    config,
  });
  rt.profiles = new AppProfiles({ dir: paths.apps, adapters: rt.adapters });
  rt.recorder = new WorkflowRecorder({ elements: rt.ui.elements });
  rt.environment = new EnvironmentContext({ backend: rt.backend, apps: rt.apps, policy: rt.policy, config, paths, logger });
  rt.host = new ToolHost({ tools: opts.tools ?? ALL_TOOLS, rt });
  rt.runner = new WorkflowRunner({
    store: rt.workflows,
    callTool: (name, args, meta) => rt.host.invoke(name, args, meta),
    checkCtx: () => checkContext(rt),
    diagnose: (o) => diagnose(rt, o),
    os: rt.os,
    logger,
  });
  rt.dispose = async () => {
    rt.sessions.disposeAll();
    rt.processes.disposeAll();
    await rt.backend.dispose?.();
    logger.close?.();
  };
  return rt;
}

/** Start the MCP server on stdio. */
export async function serve(opts = {}) {
  const rt = await createRuntime(opts);
  const server = new McpServer({ toolHost: rt.host, logger: rt.logger, instructions: SERVER_INSTRUCTIONS, input: opts.input, output: opts.output });
  rt.logger.info('server starting', { backend: rt.backend.name, level: rt.policy.level, state: rt.paths.home, project: rt.paths.project.root });
  const shutdown = async () => {
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.start();
  await rt.dispose();
}
