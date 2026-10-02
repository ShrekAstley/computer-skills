import { terminalRun, terminalSession, processTool } from './terminal.js';
import { appTool, appScript, windowTool } from './apps.js';
import { screenCapture, screenText, uiInspect, uiFind, uiAction, uiMenu, uiDialog } from './screen.js';
import { inputMouse, inputKeyboard, clipboardTool } from './input.js';
import { verifyTool, diagnoseTool } from './verify.js';
import { workflowSearch, workflowGet, workflowRun, workflowSave, workflowFeedback, workflowRecord, workflowVersions, appProfile } from './workflow.js';
import { envInspect, safetyTool } from './system.js';

/** All tools, in the order clients list them (grouped by purpose). */
export const ALL_TOOLS = [
  envInspect,
  workflowSearch,
  workflowGet,
  workflowRun,
  workflowSave,
  workflowFeedback,
  workflowRecord,
  workflowVersions,
  appProfile,
  terminalRun,
  terminalSession,
  processTool,
  appTool,
  appScript,
  windowTool,
  screenCapture,
  screenText,
  uiInspect,
  uiFind,
  uiAction,
  uiMenu,
  uiDialog,
  inputMouse,
  inputKeyboard,
  clipboardTool,
  verifyTool,
  diagnoseTool,
  safetyTool,
];

export const SERVER_INSTRUCTIONS = `computer-skills gives you structured control of this computer: terminal, processes, applications, windows, screen/OCR, accessibility, mouse/keyboard, verification, and a persistent memory of learned workflows.

Operating loop for any computer task: Goal → Inspect (env_inspect, workflow_search, app_profile) → Plan → Execute one action at a time → Observe (screen_capture / ui_find / screen_text) → Verify (verify with real evidence) → Recover (diagnose; adapt, don't blindly repeat) → Persist (workflow_save / workflow_feedback / app_profile update).

Rules: search workflows before operating an app; prefer native scripting (app_script) and CLIs (terminal_run) over GUI clicking; prefer text/element targets over raw coordinates; focus the right window before typing; verify important results (files exist, windows opened); read dialogs before accepting; never use a confirm token without the user's explicit approval; if the kill switch or failsafe triggers, stop and ask the user. Load the "computer-skills" skill for the full procedure.`;
