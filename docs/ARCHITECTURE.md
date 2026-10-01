# Architecture

```
            Claude Code / OpenCode / Cursor (MCP client)
                         │  JSON-RPC over stdio (tools/list, tools/call, elicitation, cancel)
┌────────────────────────▼─────────────────────────────────────────────────────┐
│ mcp/server.js        protocol, capability negotiation, cancellation, elicitation│
├──────────────────────────────────────────────────────────────────────────────┤
│ tools/registry.js    ToolHost pipeline:                                       │
│   validate args → kill switch → assess risk → policy (allow/confirm/deny)      │
│   → handler → audit/log → recorder → MCP content (JSON + images)               │
│ tools/*.js           28 tool definitions (schema, risk assessment, handler)     │
├───────────────┬───────────────┬─────────────────┬───────────────┬──────────────┤
│ terminal/     │ apps/         │ ui/ + screen/   │ verify/       │ workflow/    │
│ shells        │ registry      │ InputService    │ checks        │ store        │
│ run (one-shot)│ manager       │ UiService       │ verifyChecks  │ runner       │
│ sessions      │ windows (sel.)│ ElementRegistry │ diagnose      │ recorder     │
│ processes     │ adapters/*    │ ScreenService   │               │ profiles     │
│               │               │ OcrService, PNG │               │ confidence   │
├───────────────┴───────────────┴─────────────────┴───────────────┴──────────────┤
│ safety/ classifier (commands, UI labels, hotkeys, scripts, paths) + policy      │
│ context/ EnvironmentContext (persisted machine model)                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ platform/ Backend contract → LinuxBackend │ MacBackend │ WindowsBackend         │
│   linux:   xdotool, wmctrl, xwininfo, import/maim/scrot/xwd, xclip,            │
│            swaymsg/hyprctl, grim, ydotool/wtype, AT-SPI (python helper)        │
│   macos:   osascript JXA helper (CoreGraphics events, System Events, AX,       │
│            Vision OCR), screencapture, pbcopy                                   │
│   windows: persistent PowerShell 5.1 helper (SendInput, EnumWindows, GDI,       │
│            UI Automation, Windows.Media.Ocr)                                    │
└──────────────────────────────────────────────────────────────────────────────┘
State: ~/.computer-skills/{config.json, workflows/, workflows/.history/, workflows/.stats/,
       apps/, context/, logs/{server.log,audit.jsonl,apps/,processes/}, screenshots/, STOP}
Project: <repo>/.computer-skills/{config.json, workflows/}
```

## Design principles

- **Capabilities over mechanisms.** Tools describe intent (`ui_menu path`, `ui_dialog fill_path`, `app launch`); backends choose the best available mechanism and fall back (native menu API → visual navigation; accessibility action → pointer click; Vision/WinRT OCR → tesseract; wmctrl → xdotool; X11 → Wayland tools).
- **Evidence, not assumptions.** Launch waits for a window; window/focus actions report the post-state; input tools refuse to type when focus can't be obtained; `verify` polls observable conditions; workflow steps carry expectations.
- **Fail informatively.** Every error is a `ToolError {code, message, hint, recoverable, details}`; command failures are categorised; workflow failures return a diagnosis, screenshot and recovery guide.
- **Safety in one place.** All tool calls (from the client, the CLI, or inside workflows) pass through the same policy gate; workflows cannot bypass it.
- **Zero dependencies.** Node built-ins only; OS helpers are scripts shipped in `src/platform/helpers/`. Installing the plugin needs no `npm install`.
- **Low latency.** Windows uses a warm helper process; images are normalised and downscaled in-process; environment facts and app lists are cached.

## Key flows

**Tool call.** `ToolHost.invoke` validates/coerces arguments against the tool's JSON schema, checks the kill switch for mutating tools, runs the tool's `assess` (classifier + context such as the focused window or a dialog title), enforces the policy (elicitation or confirmation token when needed), runs the handler with an `AbortSignal`, logs and audits, and lets the recorder observe it.

**Screen pipeline.** Backend `capture()` → PNG → decode to RGBA → crop to region/window in logical coordinates (handling Retina `pixelRatio` and negative virtual-screen origins on Windows) → downscale to `screen.maxWidth` → encode → save → register `{id, region, scale}` so later actions can pass image coordinates with `screenshot_id`.

**Find & act.** `ui_find` searches the accessibility tree (UIA/AX/AT-SPI) by label/role, then OCR lines/word n-grams if needed; matches become element handles (`el-…`) with bounds. `ui_action` performs accessibility patterns (Invoke, Toggle, SetValue, Expand, AXPress…) and falls back to clicking the element's center.

**Workflow run.** Resolve parameters → preconditions → for each step: call the tool through the ToolHost (policy applies) → treat `ok:false` results as failures → verify `expect` (with timeout) → retry/recovery per step policy → pause on manual steps → final `expected_results` → record outcome (stats overlay for read-only built-ins).

## Extending

- **New app support:** an adapter in `src/apps/adapters/` or `~/.computer-skills/adapters/*.js` — see [ADAPTERS.md](ADAPTERS.md). Apps without adapters are still fully usable through generic tools and learned workflows.
- **New OS mechanism:** implement or extend a `Backend` method (`src/platform/base.js` documents the contract) and report it in `capabilities()`.
- **New check type:** add to `CHECK_TYPES` and `evaluateCheck` in `src/verify/checks.js`; docs regenerate from it.
- **New tool:** `defineTool({...})` in `src/tools/`, add to `ALL_TOOLS`, run `node scripts/gen-docs.js`.
