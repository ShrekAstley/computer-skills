# Computer Skills

**Give AI coding agents structured, verifiable control of the computer they run on** — terminal and processes, desktop applications, windows, screen reading (screenshots, OCR, accessibility trees), mouse and keyboard, dialogs and file pickers — with a safety policy, built-in verification and recovery, and a **persistent memory of learned app workflows** that improves every time a task succeeds or fails.

Works with **Claude Code** (one-command plugin install), **OpenCode** and **Cursor**. Cross-platform: **Windows, macOS, Linux (X11 and Wayland)**. Zero npm dependencies: the MCP server is plain Node.js ≥ 18.

```text
"Open Blender, create a terrain scene, save the project, and export the terrain."

workflow_search → blender/create-terrain-scene (partial: never verified here)
workflow_run    → app_script (Blender Python, headless) → expect: terrain.blend ✓  terrain.obj ✓
                → stats updated: next time this workflow is "known" and simply reused
```

---

## Install

### Claude Code — Install → Enable → Use

**Prerequisite:** Node.js 18 or newer on the `PATH` Claude Code starts with (`node --version`). The Claude Code native installer does not include Node.js; if it's missing, the plugin tells Claude at session start how to fix it instead of failing silently.

**1. Install** — inside Claude Code:

```
/plugin marketplace add shrekastley/expert-workflow
/plugin marketplace add shrekastley/computer-skills
/plugin install computer-skills@computer-skills
```

or from a shell: `claude plugin marketplace add shrekastley/expert-workflow && claude plugin marketplace add shrekastley/computer-skills && claude plugin install computer-skills@computer-skills` (or `./install.sh`, which runs exactly these).

The first line adds the [expert-workflow](https://github.com/shrekastley/expert-workflow) marketplace, so the `expert-workflow` plugin this one depends on installs with it. Skipped it? Run `/plugin marketplace add shrekastley/expert-workflow` afterwards — the missing dependency installs then.

This installs, in one step:

| Component | What it is |
|-----------|------------|
| MCP server `computer-skills` | 28 computer-control tools (`node …/bin/computer-skills.js serve`, no `npm install` needed) |
| Skill `computer-skills` | the operator procedure (inspect → plan → act → verify → recover → remember) |
| Subagents | `computer-operator` (executes), `app-explorer` (learns unfamiliar apps, repairs workflows) |
| Commands | `/computer-skills:computer-doctor`, `/computer-skills:computer-workflows`, `/computer-skills:operate` |
| Hook | a silent `SessionStart` Node.js check |
| Dependency | `expert-workflow@expert-workflow` from [shrekastley/expert-workflow](https://github.com/shrekastley/expert-workflow) (the orchestration methodology this skill builds on), installed automatically |

**2. Enable** — restart Claude Code (or `/reload-plugins`). Plugins are enabled on install. Confirm:

```
/mcp                                  → computer-skills  ✔ connected
/computer-skills:computer-doctor      → what works on this machine (screen, input, windows, accessibility, OCR) and what to install
```

On macOS, grant the app running Claude Code (Terminal, iTerm, VS Code, Cursor, Claude desktop) **Accessibility** and **Screen Recording** in System Settings → Privacy & Security, then restart it. Linux X11: `sudo apt install xdotool wmctrl x11-utils imagemagick xclip tesseract-ocr`. Windows: nothing extra.

**3. Use** — just ask: *"Open Blender, create a terrain scene, save the project and export the terrain"*, or `/computer-skills:operate <task>`.

#### Share with a team

Run `claude plugin install computer-skills@computer-skills --scope project` in a repo (or `./install.sh --project`), or commit this `.claude/settings.json`; teammates are prompted to install when they trust the folder:

```json
{
  "extraKnownMarketplaces": {
    "expert-workflow": { "source": { "source": "github", "repo": "ShrekAstley/expert-workflow" } },
    "computer-skills": { "source": { "source": "github", "repo": "ShrekAstley/computer-skills" } }
  },
  "enabledPlugins": { "computer-skills@computer-skills": true, "expert-workflow@expert-workflow": true }
}
```

Project-specific workflows go in `.computer-skills/workflows/` (commit them) and a stricter safety policy in `.computer-skills/config.json` (projects can only tighten safety, never loosen it).

#### Update, disable, uninstall

```bash
claude plugin marketplace update computer-skills      # fetch the latest marketplace
claude plugin update computer-skills@computer-skills  # install the new version
claude plugin disable computer-skills@computer-skills # keep installed, turn off
claude plugin uninstall computer-skills@computer-skills
claude plugin prune                                   # remove expert-workflow if nothing else needs it
```

Your learned workflows, app profiles and config live in `~/.computer-skills/` and survive updates and uninstalls.

#### Without the plugin system

`./install.sh --copy` (or `install.ps1 -Copy`) copies the skill, subagents and commands into `~/.claude/` and registers the server with `claude mcp add`; useful for air-gapped machines. The shell installers (`curl … install.sh | bash`, `irm … install.ps1 | iex`) otherwise just run the plugin commands above.

#### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/mcp` shows computer-skills failed, or Claude says Node.js is missing | Install Node.js 18+; ensure `node` is on the PATH Claude Code inherits (dock/start-menu launches may miss nvm/Homebrew paths — start Claude Code from a terminal to compare). Restart. |
| Tools work but screenshots are blank / clicks do nothing (macOS) | Grant Accessibility + Screen Recording to the host app, restart it. |
| Clicks don't reach an app (Windows) | The app runs as administrator; run Claude Code elevated or avoid it. |
| `doctor` reports missing capabilities (Linux) | Install the listed tools (`./install.sh --with-deps` does it). |
| Anything else | `node ~/.claude/plugins/cache/computer-skills/computer-skills/*/bin/computer-skills.js doctor`, logs in `~/.computer-skills/logs/`, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). |

### OpenCode

```bash
./install.sh opencode              # user: ~/.config/opencode (skill, agents, MCP entry in opencode.json)
./install.sh opencode --project    # project: ./.opencode + ./opencode.json
```

Then restart OpenCode and use the `computer-operator` agent (or any agent — the MCP tools are global). Manual setup: add to `opencode.json`

```json
{ "mcp": { "computer-skills": { "type": "local", "command": ["node", "/path/to/computer-skills/bin/computer-skills.js", "serve"], "enabled": true } } }
```

and copy `skills/computer-skills` to `~/.config/opencode/skills/`.

### Cursor

```bash
./install.sh cursor --project      # ./.cursor: mcp.json, rule, skill, agents
./install.sh cursor                # ~/.cursor: mcp.json, skill, agents
```

Restart Cursor and enable **computer-skills** under *Settings → MCP*. Manual setup: `.cursor/mcp.json`

```json
{ "mcpServers": { "computer-skills": { "command": "node", "args": ["/path/to/computer-skills/bin/computer-skills.js", "serve"] } } }
```

plus `adapters/cursor/rules/computer-skills.mdc` → `.cursor/rules/`.

### All / uninstall / extras

```bash
./install.sh all                   # every client
./install.sh --uninstall cursor
./install.sh --with-deps           # also install recommended OS helpers (asks for sudo)
node bin/computer-skills.js install-config --target cursor --scope user --dry-run
```

OpenCode/Cursor installs copy the server to `~/.computer-skills/runtime` and register it with an absolute Node path (GUI apps often lack your shell `PATH`). Existing config files are merged and backed up (`.bak`); JSONC files with comments are never rewritten — the snippet is printed instead.

### Platform prerequisites

Run `computer-skills doctor` (or `/computer-skills:computer-doctor`) to see what works and what's missing.

| OS | Needs |
|----|-------|
| Windows 10/11 | Nothing extra (Windows PowerShell 5.1 helper: SendInput, UI Automation, WinRT OCR). |
| macOS 12+ | Grant the host app (Terminal / iTerm / VS Code / Cursor / Claude) **Accessibility** and **Screen Recording** permissions. Optional: `brew install tesseract cliclick`. |
| Linux X11 | `sudo apt install xdotool wmctrl x11-utils imagemagick xclip tesseract-ocr` (+ `python3-gi gir1.2-atspi-2.0` for accessibility). |
| Linux Wayland | sway/Hyprland for windows; `grim` for capture; `ydotool`/`wtype` for input. GNOME/KDE Wayland limit automation (XWayland apps still work). |

Details: [`skills/computer-skills/references/platforms.md`](skills/computer-skills/references/platforms.md).

---

## What the agent gets

28 MCP tools ([full reference](docs/TOOLS.md)):

| Area | Tools |
|------|-------|
| Environment | `env_inspect` — OS, displays, shells, dev tools with versions, installed apps, capabilities (+ install hints), important dirs, safety level. Cached and persisted. |
| Terminal | `terminal_run` (one-shot, exit codes, failure categories, retries) · `terminal_session` (persistent shells & REPLs, exit-code markers, PTY mode, signals) · `process` (background servers with readiness detection and logs; OS process table) |
| Applications | `app` (find / launch-and-wait-for-window / status / quit / open) · `app_script` (Blender Python, Godot, Unity batch, headless Chrome/Edge/Firefox, VS Code CLI, Photoshop ExtendScript) · `window` |
| Screen & UI | `screen_capture` · `screen_text` (OCR) · `ui_inspect` (accessibility tree) · `ui_find` (by label; a11y → OCR fallback) · `ui_action` · `ui_menu` · `ui_dialog` (detect / read / accept / cancel / fill native file pickers) |
| Input | `input_mouse` (click/drag/scroll by element, text, screenshot or screen coordinates) · `input_keyboard` (`mod+s` = Cmd/Ctrl) · `clipboard` |
| Verification | `verify` (16 check types, wait-until semantics, evidence) · `diagnose` (crash, dialogs, focus, logs, screenshot → recovery suggestions) |
| Memory | `workflow_search` · `workflow_get` · `workflow_run` · `workflow_save` · `workflow_feedback` · `workflow_record` · `workflow_versions` · `app_profile` |
| Safety | `safety` (status / dry-run check / audit / stop) |

### The operating loop

The skill teaches agents to work as **Goal → Inspect → Plan → Execute → Observe → Verify → Recover → Persist**, preferring the most reliable mechanism: CLI → app scripting → menus/accessibility → shortcuts → text-targeted clicks → coordinates. See [`skills/computer-skills/SKILL.md`](skills/computer-skills/SKILL.md).

### Workflow memory and learning

- Workflows are versioned JSON documents (steps = tool calls or manual instructions, each with `expect` checks; parameters; preconditions; expected results; known failure modes; hints; stats).
- `workflow_search` classifies a task as **known** (verified, reliable here), **partial** (exists but unverified/stale/failing/other OS or version) or **unknown**.
- `workflow_run` executes with per-step verification; on failure it stops with a diagnosis, screenshot and recovery guide — the agent adapts, completes the task, and saves an improved **version** (old ones archived, restorable).
- `workflow_record` captures what the agent does while exploring an unfamiliar app and turns it into a draft workflow (ephemeral element ids become durable text targets; verify calls become step expectations).
- `app_profile` keeps per-app knowledge (shortcuts, UI locations, quirks, versions) merged with built-in adapter knowledge.
- Scopes: user (`~/.computer-skills/workflows`), project (`.computer-skills/workflows`, shareable in git), built-in examples.

Format and reliability model: [`references/workflow-format.md`](skills/computer-skills/references/workflow-format.md).

### Safety

Every action is risk-classified — `safe < low < medium < high < critical < forbidden` — and gated by the user's level:

| Risk | restricted | normal (default) | trusted |
|------|------------|------------------|---------|
| safe (read-only) | allow | allow | allow |
| low (ordinary work, GUI input) | confirm | allow | allow |
| medium (kill, push, installs into a project, overwrite) | confirm | allow | allow |
| high (recursive delete, sudo, system installs, force-push, "Don't Save") | deny | confirm | allow |
| critical (shutdown, security off, protected paths) | deny | confirm | confirm |
| forbidden (`rm -rf /`, mkfs, disk wipes, fork bombs) | deny | deny | deny |

Confirmation uses MCP elicitation (an approval prompt in the client) when supported, otherwise a single-use token bound to the exact arguments that the agent may only use after asking you. Also: protected paths, blocked apps, deny/allow command patterns, a kill switch (`computer-skills stop`), a mouse-to-corner failsafe, and an audit log. Projects can make policy stricter but never looser. See [docs/SAFETY.md](docs/SAFETY.md).

Set the level with `COMPUTER_SKILLS_LEVEL=restricted|normal|trusted` or `~/.computer-skills/config.json` (`computer-skills config init`).

---

## CLI

```text
computer-skills serve | doctor | tools | env [sections] | call <tool> '<json>' [--yes]
                workflows list|show|validate|export|import | stop | resume | audit [n]
                config show|init|path | install-config --target claude|cursor|opencode [--scope user|project]
```

`call` runs any tool directly (asks on the terminal before risky actions) — handy for debugging and scripting.

## Repository layout

```text
.claude-plugin/          plugin.json (incl. MCP server) + marketplace.json
bin/computer-skills.js   CLI + MCP stdio server entry point
src/
  core/                  config, errors, logging, process execution, keys, paths
  mcp/                   dependency-free MCP (JSON-RPC over stdio, elicitation, cancellation)
  safety/                risk classifier, policy engine, confirmations, audit
  platform/              OS backends: linux (X11/Wayland), macos (JXA), windows (PowerShell helper) + helpers/
  screen/                capture pipeline (PNG codec, crop/scale, change detection), OCR engines
  ui/                    input service, element registry, accessibility/OCR search, menus, dialogs
  apps/                  app discovery & lifecycle, window selectors, adapters/ (Blender, browsers, IDEs, engines…)
  terminal/              shells, one-shot runs, interactive sessions, background processes
  verify/                check vocabulary, wait/verify engine, diagnosis
  workflow/              schema, store (versions, scopes, stats), confidence, runner, recorder, app profiles
  context/               persistent environment model
  tools/                 the 28 agent-facing tool definitions and the tool host pipeline
skills/computer-skills/  SKILL.md (operator procedure) + references/
agents/, commands/       Claude Code subagents and slash commands
adapters/                OpenCode and Cursor agents/rules
examples/workflows/      built-in example workflows
docs/                    architecture, safety, adapters, troubleshooting, tool reference
test/unit, test/integration
install.sh, install.ps1
```

## Development

```bash
npm test                  # unit tests (node:test, no dependencies)
npm run test:integration  # MCP over stdio, CLI, and real X11 GUI automation (auto-starts Xvfb if available)
npm run lint              # syntax, unused imports, manifests, generated docs, example workflows
node scripts/gen-docs.js  # regenerate docs/TOOLS.md from the tool definitions
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ADAPTERS.md](docs/ADAPTERS.md) (adding app adapters or OS mechanisms), [CONTRIBUTING.md](CONTRIBUTING.md).

## Status and limits

- Verified end to end on Linux/X11 (unit + integration tests including real GUI automation and Blender 4.0 headless workflows). The Windows and macOS backends are implemented against documented OS APIs and covered by unit tests of their mapping logic; run `computer-skills doctor` and the integration tests on those systems — reports welcome.
- Wayland compositors restrict input and window control by design; see platform notes.
- Accessibility coverage depends on the app (Blender, games and many custom-drawn UIs expose none → OCR + shortcuts + scripting).
- The safety classifier is a guard-rail, not a sandbox. Use `restricted` level and your client's own permission prompts for untrusted tasks.

## License

MIT
