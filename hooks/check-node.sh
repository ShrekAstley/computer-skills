#!/bin/sh
# computer-skills SessionStart check. Silent when Node.js >= 18 is available.
# Otherwise it explains (to Claude, via session context) why the computer-skills
# MCP tools are missing: the Claude Code native installer does not ship Node.js,
# and GUI-launched apps often don't inherit the shell PATH (nvm, Homebrew, Volta).
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
  case "$major" in
    ''|*[!0-9]*) major=0 ;;
  esac
  [ "$major" -ge 18 ] && exit 0
  problem="Node.js $(node --version 2>/dev/null) is too old (18 or newer is required)"
else
  problem="Node.js was not found on the PATH that Claude Code uses"
fi
# Shell builtins only: the PATH may be minimal precisely when node is missing.
printf '%s\n' \
  "computer-skills plugin: ${problem}, so its MCP server (the computer-control tools) cannot start." \
  "If the user asks for computer/desktop/app automation, tell them first:" \
  "- Install Node.js 18+: https://nodejs.org (macOS: brew install node; Windows: winget install OpenJS.NodeJS.LTS; Linux: your package manager or nvm)." \
  "- Make sure 'node' is on the PATH Claude Code is started with (apps launched from a dock/start menu may not see nvm/Homebrew paths; starting Claude Code from a terminal helps)." \
  "- Then restart Claude Code and check /mcp for \"computer-skills\"."
exit 0
