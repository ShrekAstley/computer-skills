# Recovery playbook

Principle: **detect → inspect → determine what changed → adapt → complete → update memory.** Never re-run a failed action or workflow unchanged; two failed attempts at the same step means stop and rethink (or escalate / ask the user).

Start every recovery with evidence: `diagnose {"app": "<app>"}` (focused window, app running?, open dialogs with text and buttons, app log tail, screenshot) or at least `screen_capture` of the relevant window.

## Application crashed / not running

- Signs: `diagnose` says "not running", `app status` shows no windows/processes, `APP_NOT_RUNNING`, a workflow step's `window_exists` check fails.
- Do: read `app_log_tail` (or `process logs`), relaunch (`app launch`), reopen the document, check for an autosave/recovery prompt (read it; recovering is usually right), resume from the last verified step (`workflow_run` with `start_at`).
- If it crashes again at the same action: avoid that path (different exporter, smaller input, scripting instead of GUI) and tell the user.

## Missing application

- `app find` returns nothing relevant → try aliases (`code` vs "Visual Studio Code"), `env_inspect sections=["apps"] refresh=true`, look for a CLI on PATH.
- Still missing → ask the user. Installing software is high risk and needs approval; propose the exact command (`winget install …`, `brew install --cask …`, `sudo apt install …`).

## Unexpected dialogs and prompts

- `ui_dialog detect` / `read` → understand it before acting.
- Informational / "what's new" / tips → `cancel` or close.
- "Save changes?" while quitting → only "Save" is safe without asking; "Don't Save" discards work → ask the user.
- "Replace existing file?" → ask unless the user asked to overwrite.
- Permission / UAC / password / keychain prompts → stop; the user must handle them.
- Login / license / update prompts → ask the user.
- Recovery / autosave prompts after a crash → usually recover; mention it.

## Changed UI layout / control not found

- Re-observe: fresh `screen_capture`; `ui_find` with the label (fuzzy; try synonyms: "Export…", "Save As…", "Render Image").
- Try other routes in order: menu path (`ui_menu`, or visual), keyboard shortcut (`app_profile` / adapter knowledge), command palette or operator search (`mod+shift+p`, Blender `f3`), scripting (`app_script`).
- Check version differences (`app launch` reports `version`; workflows carry `tested_version`).
- After success: `workflow_save` same id with `change_note`, update `hints.location`; `app_profile update` the `ui_map`.

## Invalid commands

- `terminal_run` returns `failure.category`:
  - `not-found`: wrong program or not installed — check `env_inspect tools`, use the right shell (`shell: "pwsh"` vs `"bash"`).
  - `syntax`: you used the wrong shell dialect or quoting — PowerShell ≠ bash ≠ cmd.
  - `permission`: wrong file ownership or protected location — don't escalate privileges without approval.
  - `conflict`: version-control conflict — resolve deliberately.

## Permission failures

- macOS: "not allowed assistive access" / blank screenshots → the host app (Terminal, iTerm, VS Code, Cursor, Claude) needs **Accessibility** and **Screen Recording** in System Settings → Privacy & Security. Tell the user; then restart the host app.
- Windows: input does nothing in an app running as administrator (UIPI) → the agent must run elevated too, or avoid that app.
- Linux Wayland: input/window tools missing → `env_inspect capabilities` shows what to install (ydotool, wtype, grim) or run the app under XWayland.

## Network failures

- Category `network` → retry with backoff (`retries: 3, retry_on: "network"`). Persisting → check connectivity (`verify http_ok`), proxy variables, VPN; tell the user.

## Timeouts

- Commands: increase `timeout_ms`, or move to `process start` with a `ready_pattern` and poll logs.
- GUI: long operations (renders, exports, installs) → `verify` with a generous `timeout_ms` on the observable result (file appears, window title changes, progress dialog disappears: `window_absent`).

## Window focus issues

- Keystrokes went to the wrong window → undo if possible (`mod+z` in the wrong app only if you're sure), `window focus` the right one, verify `window_focused`, redo.
- Focus stealing prevention refuses focus → click inside the target window (title bar or a neutral area), or `window restore` first.
- Input tools with a window selector refuse to type when focus can't be obtained — that's intended.

## Lost application state

- The document closed / view changed → reopen it, navigate back, re-verify preconditions, resume from the last verified step.
- Prefer workflows whose steps are idempotent and whose expectations check end-state (files, titles) rather than transient UI.

## When to stop

- The same step failed twice with different approaches.
- The fix requires a high-risk action the user hasn't approved.
- The kill switch / failsafe fired.
- You are no longer sure what the app state is and continuing could damage user data.

Explain what you tried, what you observed (attach the screenshot), and what you need.
