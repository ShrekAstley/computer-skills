import { brief, selectWindows } from '../apps/windows.js';
import fs from 'node:fs';

/**
 * Snapshot the situation after something went wrong, with concrete
 * observations and suggested next steps. This is the "inspect the current
 * state / determine what changed" half of error recovery.
 */
export async function diagnose({ backend, apps, ui, policy, screen }, { app, includeScreenshot = false, readDialogs = true } = {}) {
  const observations = [];
  const suggestions = [];
  const out = { observations, suggestions };

  if (policy.isStopped()) {
    observations.push('The kill switch (STOP file) is engaged.');
    suggestions.push('Stop. The user paused automation; ask them before continuing.');
  }

  let windows = [];
  try {
    windows = await backend.listWindows();
  } catch (err) {
    observations.push(`Cannot list windows: ${err.message}`);
  }
  const focused = windows.find((w) => w.focused) ?? null;
  out.focused_window = brief(focused);
  out.window_count = windows.length;

  if (app) {
    const st = await apps.status({ name: app }).catch((err) => ({ error: err.message }));
    out.app = st;
    if (st.error) observations.push(`Could not determine status of ${app}: ${st.error}`);
    else if (!st.running) {
      observations.push(`${st.app ?? app} is not running (it crashed, was closed, or never started).`);
      suggestions.push(`Relaunch ${st.app ?? app} (app action "launch") and resume from the last verified step. If it keeps crashing, check its log.`);
      const launched = [...apps.launched.values()].filter((l) => l.name === st.app).pop();
      if (launched?.logFile) {
        try {
          const tail = fs.readFileSync(launched.logFile, 'utf8').trim().split('\n').slice(-20).join('\n');
          if (tail) out.app_log_tail = tail;
        } catch {
          /* no log */
        }
      }
    } else {
      if (!st.focused) {
        observations.push(`${st.app} is running but not focused (focused: "${focused?.title ?? 'nothing'}").`);
        suggestions.push(`Focus the ${st.app} window (window action "focus") before sending input.`);
      }
      if (st.windows.length === 0) observations.push(`${st.app} has a process but no visible window (minimized, on another workspace, or still loading).`);
      if (st.windows.some((w) => w.minimized)) suggestions.push('Restore the minimized window (window action "restore").');
    }
  }

  try {
    const dialogs = await ui.detectDialogs(app ? { app } : {});
    if (dialogs.length) {
      out.dialogs = [];
      for (const d of dialogs.slice(0, 3)) {
        const info = readDialogs ? await ui.readDialog(d).catch(() => ({ dialog: d })) : { dialog: d };
        out.dialogs.push(info);
        observations.push(`Dialog open: "${d.title}"${info.text ? ` — ${info.text.split('\n').slice(0, 3).join(' / ')}` : ''}`);
      }
      suggestions.push('An open dialog is probably blocking the app. Read it and respond with ui_dialog (accept/cancel/press a specific button) — destructive choices need the user\'s approval.');
    }
  } catch (err) {
    observations.push(`Dialog detection failed: ${err.message}`);
  }

  if (focused && app) {
    const mine = selectWindows([focused], { app });
    if (!mine.length && !out.dialogs?.length) observations.push(`Unexpected window has focus: "${focused.title}" (${focused.app}).`);
  }

  if (includeScreenshot) {
    try {
      const { meta, png } = await screen.capture({});
      out.screenshot = { id: meta.id, path: meta.path, width: meta.width, height: meta.height, scale: meta.scale };
      out.__image = png;
    } catch (err) {
      observations.push(`Screenshot failed: ${err.message}`);
    }
  }

  if (!observations.length) {
    observations.push('No obvious problem detected (app running, no dialogs).');
    suggestions.push('Take a screenshot and compare it with the expected state of the failed step; the UI layout may have changed (different version, theme, or language). Locate controls by text with ui_find instead of fixed coordinates, then update the workflow.');
  }
  return out;
}
