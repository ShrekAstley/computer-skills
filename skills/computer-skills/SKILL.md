---
name: computer-skills
description: Operate the computer like a careful human operator — run terminal commands and background processes, launch and drive desktop applications (Blender, browsers, IDEs, game engines, any app), read the screen (screenshots, OCR, accessibility tree), use mouse and keyboard, handle dialogs, verify results, recover from failures, and remember learned app workflows. Use whenever a task goes beyond editing code - "open X and do Y", "export/render/convert in an app", "click/type/navigate", "check what's on screen", "automate this app".
---

# Computer Skills — operator procedure

You control this computer through the `computer-skills` MCP tools. Treat every GUI action as an experiment: **observe → act → verify**. Prefer the most reliable mechanism available, never assume an action worked, and leave the user's machine in a known state.

This skill builds on the **Expert Workflow** methodology (plan, delegate where it pays, verify with evidence, escalate on struggle, capture repeatable work). If the `expert-workflow` skill is installed, follow it for orchestration; the computer-specific rules below take precedence for anything touching the screen, input devices or the OS.

## The loop

`Goal → Inspect → Plan → Execute → Observe → Verify → Recover → Persist`

1. **Goal** – restate the outcome as observable facts ("`~/out/terrain.glb` exists and opens", not "export it").
2. **Inspect** (before touching anything)
   - `workflow_search` with the task and app. **Always**, before operating an app.
     - `known` → `workflow_run` it (dry_run first if parameters are unclear).
     - `partial` → `workflow_get`, then run carefully or follow its steps manually, verifying each.
     - `unknown` → `app_profile get` for built-in knowledge (shortcuts, menus, scripting, pitfalls), then explore (see *Learning an unfamiliar app*).
   - `env_inspect` once per session (cached): OS, display server, shells, tools, what capabilities work here.
   - `app action find` if you are not sure the app is installed.
3. **Plan** – choose the most reliable mechanism for each sub-task, in this order:
   1. Files / CLIs / `terminal_run` (e.g. convert with ffmpeg rather than a GUI converter).
   2. The app's own scripting API via `app_script` (Blender Python, Godot, Unity batch mode, headless browsers, Photoshop ExtendScript).
   3. Native UI semantics: `ui_menu`, `ui_action` on accessibility elements, `ui_dialog`.
   4. Keyboard shortcuts (`input_keyboard press`, `mod` = Cmd/Ctrl).
   5. Text-targeted pointer actions (`input_mouse` with `text` or `element`).
   6. Raw coordinates from a fresh screenshot — last resort.
4. **Execute** one meaningful action at a time. Focus the target window first (window selector on input tools does this and refuses to type into the wrong window).
5. **Observe** – `screen_capture` (window-scoped is cheaper), `ui_find`, `screen_text`, or `ui_inspect` to see the actual result.
6. **Verify** with `verify` using real evidence: `window_exists` after launches, `file_exists` (with `modified_after_start`/`modified_within_s`) after saves/exports, `text_visible` for UI state, `command_succeeds`/`port_open`/`http_ok` for services. Use `timeout_ms` to wait instead of sleeping.
7. **Recover** when evidence disagrees with expectation (see *Recovery*). Never repeat a failed action unchanged.
8. **Persist** what you learned (see *Workflow memory*).

## Tool map

| Need | Tools |
|------|-------|
| Know the machine | `env_inspect`, `app` (find/status/adapters), `process` (system) |
| Commands | `terminal_run` (one-shot, exit codes, retries), `terminal_session` (stateful shells/REPLs, `pty` for interactive programs), `process` (background servers with readiness + logs) |
| Applications | `app` (launch waits for the window; `if_running`), `app_script` (native scripting), `window` (list/focus/move/resize/minimize/close) |
| See | `screen_capture` (returns `screenshot_id`), `screen_text` (OCR lines with boxes), `ui_inspect` (accessibility tree), `ui_find` (by label/role; a11y → OCR fallback) |
| Act | `ui_action` (press/set_value/toggle/expand on elements), `ui_menu` (menu paths), `ui_dialog` (detect/read/accept/cancel/press/fill_path), `input_mouse`, `input_keyboard`, `clipboard` |
| Check & recover | `verify`, `diagnose` |
| Memory | `workflow_search`, `workflow_get`, `workflow_run`, `workflow_save`, `workflow_feedback`, `workflow_record`, `workflow_versions`, `app_profile` |
| Safety | `safety` (status/check/audit/stop) |

Details for every tool: `references/tools.md`.

## Coordinates

- Screen coordinates are logical (what the mouse uses). Screenshots may be downscaled: either convert using the formula in the screenshot result or pass `screenshot_id` with image coordinates to `input_mouse` and it converts for you.
- Prefer `text`/`element` targets — they survive window moves, DPI changes and theme changes, and they record into durable workflows.
- Take a new screenshot after anything that changes layout; element ids and coordinates go stale.

## Learning an unfamiliar app

1. `app_profile get` (adapter knowledge + anything learned earlier). If the app has `app_script`, try that first.
2. `workflow_record start` (name, app) so your successful actions become a draft.
3. `app launch` → `screen_capture` of its window → `ui_inspect format=flat interactive_only=true` (if the tree is empty the app draws its own UI: use `screen_text`/`ui_find method=ocr`).
4. Explore *only what the task needs*: open the most likely menu (`ui_menu` or click its label), screenshot, read, close with `escape`. Look for the command palette / search (many apps: `mod+shift+p`, Blender: `f3`) — searching by name beats hunting through menus.
5. Execute the task step by step, verifying each important step (successful `verify` calls are attached to the recorded step).
6. `workflow_record stop` → clean the draft (remove exploration, add titles, `{{parameters}}`, `expect` checks, `expected_results`, `failure_modes`, `hints` with menu locations/shortcuts) → `workflow_save` with `verified: true`.
7. `app_profile update` with reusable facts: shortcuts that worked, where controls live (`ui_map`), quirks, the version.

## Workflow memory

- Search before acting; reuse before re-deriving. Report outcomes: `workflow_run` records them; if you completed a workflow manually or resumed it mid-way, call `workflow_feedback`.
- When a known workflow fails, **do not re-run it unchanged**. Read the failure report (diagnosis, screenshot, recovery guide, known failure modes), adapt, finish the task, then `workflow_save` the improved version with the **same id** and a `change_note` explaining what changed (e.g. "Export moved to File > Export > glTF in 4.2"). Versions are archived; `workflow_versions` can roll back.
- Save with `scope: "project"` when the workflow belongs to this repository (shared with the team via git).
- Workflows must be parameterised (`{{output_path}}`), never contain secrets, and should prefer scripting/keyboard/text targets over coordinates.
- Statuses: `known` (verified, reliable here) · `partial` (exists but unverified, stale, failing, other OS/version) · `unknown`.

## Recovery

Detect → inspect → determine what changed → adapt → complete → update memory. `diagnose` (with the app name) does the inspection: crash detection, open dialogs and their text/buttons, focus problems, app log tail, screenshot. Playbook for each failure class: `references/recovery.md`. Short version:

- **Unexpected dialog** → `ui_dialog read`; respond deliberately; destructive choices ("Don't Save", "Replace", "Delete") need the user's approval.
- **App crashed / not running** → relaunch, reopen the document, resume from the last verified step (`workflow_run start_at`).
- **Control not found / layout changed** → screenshot; `ui_find` by text (fuzzy); try the menu path, the shortcut, or command search; record the new location.
- **Focus lost / keystrokes went elsewhere** → `window focus`, re-verify, redo.
- **Command failed** → read `failure.category`: `network`/`locked`/`timeout` are retryable (`retries`), `not-found`/`permission`/`syntax` need a different command, not a retry.
- **Permission errors (macOS Accessibility/Screen Recording, elevated Windows apps)** → tell the user exactly what to grant; do not try to bypass.
- **Two attempts failed on the same step** → stop and rethink (Expert Workflow: escalate to a stronger tier/expert, or ask the user) instead of looping.

## Safety rules (non-negotiable)

- Actions are risk-classified (safe → low → medium → high → critical → forbidden) and gated by the user's level (`restricted` / `normal` / `trusted`). Check with `safety status`; dry-run a command with `safety check`.
- `CONFIRMATION_REQUIRED` → ask the user, quoting the action and reasons. Only after explicit approval retry with the same arguments plus `confirm`. Never reuse a token for something else, never "pre-approve" yourself.
- `POLICY_DENIED` / forbidden → do not look for workarounds (other shells, encodings, GUI equivalents). Explain and let the user act.
- `KILL_SWITCH` (STOP file or mouse in the top-left corner) → stop immediately and ask the user.
- Do not drive password managers, banking, or security settings; do not type secrets the user did not give you for that purpose; read dialogs before accepting; prefer reversible actions; don't close apps with unsaved user work without asking.
- The user's apps and windows are a shared, single resource: **never run GUI automation from parallel agents**. Parallelise only terminal/CLI/headless work.

## Working with Expert Workflow (multi-agent)

- `scout` (cheap, read-only): `env_inspect`, `workflow_search`, `app_profile get`, `screen_text`, `ui_inspect`, log reading. No input tools.
- `worker`: execute a known workflow or a well-specified sequence; must verify each step and report evidence.
- `expert`: learning an unfamiliar app, adapting a broken workflow, deciding on risky operations, designing `app_script` code.
- Only one agent at a time may use input/window tools. The orchestrator owns the screen.
- This plugin ships `computer-operator` (executes) and `app-explorer` (learns/adapts) subagents that follow this skill.

## Example

"Open Blender, create a terrain scene, save the project, and export the terrain."

1. `workflow_search {"query": "create terrain scene and export terrain", "app": "blender"}` → `blender/create-terrain-scene` (partial: never verified here).
2. `app action find "blender"` → installed. `workflow_run {"id": "blender/create-terrain-scene", "params": {"blend_path": "<abs>/terrain.blend", "export_path": "<abs>/terrain.obj"}}`.
3. Each step verified (`file_exists` for both outputs); stats updated → `known` next time.
4. If it fails (e.g. glTF exporter missing numpy in a distro build), read the traceback in the failure report, switch format or adapt the script, finish, and `workflow_save` the improved version.
5. If the user wants to *see* it: `app launch {"name": "blender", "params": {"file": "<abs>/terrain.blend"}}` → `verify window_exists` → `screen_capture`.
