---
description: Check that computer-skills is installed and working - MCP server, Node.js, and which computer-control capabilities (screen, input, windows, accessibility, OCR) work on this machine, with what to install for the missing ones.
---

Report on the computer-skills installation and this computer's capabilities.

1. If the computer-skills MCP tools (e.g. `env_inspect`) are **not available** in this session, the server did not start. Diagnose with Bash instead:
   - `node --version` (must be 18 or newer; the Claude Code native installer does not include Node.js),
   - `node "<plugin root>/bin/computer-skills.js" doctor` — find the plugin root with `claude plugin list` / the plugin cache under `~/.claude/plugins/cache/computer-skills/`,
   - then explain the fix (install Node.js 18+, make sure `node` is on the PATH Claude Code starts with, restart Claude Code, check `/mcp`). Stop here.
2. Otherwise call `env_inspect` with sections ["system", "session", "displays", "shells", "capabilities", "safety"] and refresh=true.
3. Summarise in a short table: capability, available?, mechanism, what to install/grant if missing (use the hints; on macOS mention Accessibility and Screen Recording permissions for the app running Claude Code).
4. Report the safety level and whether the kill switch is engaged.
5. List learned workflows briefly with `workflow_versions` action "all".

Do not install anything; only report and suggest. $ARGUMENTS
