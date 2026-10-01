# Workflow format

Workflows are JSON documents stored one per file: `~/.computer-skills/workflows/<app>/<task>.json` (user scope) or `<project>/.computer-skills/workflows/<app>/<task>.json` (project scope, shareable through git). Built-in examples ship with the plugin and are read-only (their run statistics live in an overlay). Precedence when ids collide: project > user > extra dirs > built-in.

```jsonc
{
  "id": "blender/render-png",              // <app>/<task>; derived from app + name if omitted
  "name": "Render a Blender project to PNG",
  "app": { "name": "Blender", "version": ">=3.6", "tested_version": "4.2.1" },
  "platforms": ["linux", "windows", "macos"],   // where it was verified
  "description": "…", "tags": ["render"], "triggers": ["export the project as png"],
  "parameters": [
    { "name": "output_path", "type": "path", "required": true, "description": "…" },
    { "name": "samples", "type": "integer", "default": 16 }
  ],
  "preconditions": [ { "type": "file_exists", "path": "{{blend_file}}" } ],
  "steps": [
    {
      "id": "render",
      "title": "Render (F12)",
      "action": { "tool": "input_keyboard", "args": { "action": "press", "keys": "f12" } },
      "expect": [ { "type": "window_exists", "title_regex": "Render" } ],
      "timeout_ms": 120000,          // how long expectations may take to become true
      "retries": 1,                  // re-run the action if it or its expectations fail
      "on_failure": "abort",         // abort | retry | recover | continue
      "recovery": [ { "action": { "tool": "input_keyboard", "args": { "action": "press", "keys": "escape" } } } ],
      "hints": { "location": "Render > Render Image", "shortcut": "F12", "notes": "Mouse must be over the 3D view" }
    },
    {
      "id": "save",
      "title": "Save the image",
      "manual": "Image > Save As, type {{output_path}}, confirm.",   // agent performs it; run pauses
      "expect": [ { "type": "file_exists", "path": "{{output_path}}" } ]
    }
  ],
  "expected_results": [ { "type": "file_exists", "path": "{{output_path}}", "min_bytes": 1000 } ],
  "failure_modes": [ { "symptom": "F12 does nothing", "recovery": "Move the mouse over the viewport first" } ],
  "notes": ["…"],
  "stats": { "runs": 3, "successes": 3, "failures": 0, "last_verified": "2026-09-30T12:00:00Z", "...": "…" },
  "version": 2, "history": [ { "version": 2, "date": "…", "change": "Export moved in 4.2" } ]
}
```

## Steps

- `action.tool` is any computer-skills tool except `workflow_*`; each call goes through the safety policy exactly as if you made it.
- `{{param}}` placeholders work in any string (whole-string placeholders keep the parameter's type).
- A tool that reports `ok: false` (non-zero exit, script error) fails the step even without expectations.
- `manual` steps pause the run and return the instruction; resume with `workflow_run start_at=<next step id>` — the manual step's `expect` is verified first.
- Steps blocked by policy return `status: "blocked"`; perform that step yourself with the user's approval, then resume.

## Writing robust workflows

- Prefer, in order: scripting (`app_script`) > CLI > menus/accessibility (`ui_menu`, `ui_action` by `text`) > shortcuts > text-targeted clicks > coordinates.
- Every step that changes state should have an `expect` with observable evidence.
- Make steps idempotent where possible and check end-state, not transient UI.
- Put version-specific knowledge in `app.version` / `tested_version` and `failure_modes`.
- Never store secrets, personal data, or machine-specific absolute paths — use parameters.

## Reliability

`confidence = (successes + 1) / (runs + 2)`, adjusted down for staleness (not verified in `staleAfterDays`, default 90), a failing most-recent run, a different OS, or an app version outside the declared range. `known` ≥ 0.65 and verified here; otherwise `partial`. `workflow_run` updates the stats; use `workflow_feedback` for manual or resumed runs.

## Versioning

Saving an existing id bumps `version`, appends to `history` and archives the previous file under `~/.computer-skills/workflows/.history/<app>/<task>/v<N>.json`. `workflow_versions list|restore|delete`. Use `reset_stats: true` when the procedure changed fundamentally.
