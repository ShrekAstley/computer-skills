#!/usr/bin/env bash
# Computer Skills installer for Claude Code, OpenCode and Cursor (macOS / Linux / Git Bash).
#
#   ./install.sh                      # Claude Code via its built-in plugin installer
#   ./install.sh opencode             # OpenCode (user scope)
#   ./install.sh cursor --project     # Cursor, into ./.cursor + ./.cursor/mcp.json
#   ./install.sh all
#   ./install.sh --uninstall [target]
#
# Remote one-liner:
#   curl -fsSL https://raw.githubusercontent.com/shrekastley/computer-skills/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- cursor --project
set -euo pipefail

REPO="${COMPUTER_SKILLS_REPO:-shrekastley/computer-skills}"
REF="${COMPUTER_SKILLS_REF:-main}"
PLUGIN="computer-skills"
MARKETPLACE="computer-skills"
STATE_HOME="${COMPUTER_SKILLS_HOME:-$HOME/.computer-skills}"
RUNTIME="$STATE_HOME/runtime"

TARGET=""
SCOPE=""
UNINSTALL=0
FORCE_COPY=0
WITH_DEPS=0

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage: install.sh [claude|opencode|cursor|all] [options]

Options:
  --project        Install into the current project instead of your user profile
  --global, --user Install for your user (default)
  --copy           (claude) skip the plugin installer; register the MCP server + copy skill/agents
  --with-deps      Also install recommended OS helpers (xdotool, wmctrl, tesseract, ...) — asks sudo
  --uninstall      Remove what this script installed
  --repo SLUG      GitHub repo to install from (default: $REPO)
  --ref REF        Git ref to install from (default: $REF)
  -h, --help       Show this help

Default target is 'claude'. Requires Node.js >= 18.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    claude|opencode|cursor|all) TARGET="$1" ;;
    --project) SCOPE="project" ;;
    --global|--user) SCOPE="user" ;;
    --copy) FORCE_COPY=1 ;;
    --with-deps) WITH_DEPS=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --repo) shift; REPO="${1:?--repo needs a value}" ;;
    --ref) shift; REF="${1:?--ref needs a value}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
  shift
done
TARGET="${TARGET:-claude}"
SCOPE="${SCOPE:-user}"

# ---- prerequisites -----------------------------------------------------------
check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js >= 18 is required (https://nodejs.org). Install it and re-run."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node.js >= 18 is required (found $(node --version))."
}

install_os_deps() {
  [ "$WITH_DEPS" -eq 1 ] || return 0
  case "$(uname -s)" in
    Linux)
      local pkgs="xdotool wmctrl x11-utils imagemagick xclip tesseract-ocr python3-gi gir1.2-atspi-2.0"
      if command -v apt-get >/dev/null; then say "Installing: $pkgs"; sudo apt-get install -y $pkgs || warn "apt-get failed; install manually"
      elif command -v dnf >/dev/null; then sudo dnf install -y xdotool wmctrl xorg-x11-utils ImageMagick xclip tesseract python3-gobject at-spi2-core || warn "dnf failed"
      elif command -v pacman >/dev/null; then sudo pacman -S --needed xdotool wmctrl xorg-xwininfo imagemagick xclip tesseract tesseract-data-eng python-gobject at-spi2-core || warn "pacman failed"
      else warn "Unknown package manager; see docs/PLATFORMS.md"; fi ;;
    Darwin)
      if command -v brew >/dev/null; then brew install tesseract cliclick || warn "brew failed"; else warn "Homebrew not found; optional: brew install tesseract cliclick"; fi
      warn "Grant Accessibility + Screen Recording to your terminal/editor in System Settings → Privacy & Security." ;;
  esac
}

# ---- locate sources (local checkout, else fetch) ------------------------------
SRC=""
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT

find_local_src() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || return 1
  [ -f "$here/skills/computer-skills/SKILL.md" ] && [ -f "$here/bin/computer-skills.js" ] && SRC="$here"
}

ensure_src() {
  [ -n "$SRC" ] && return 0
  find_local_src && return 0
  TMP="$(mktemp -d)"
  say "Fetching $REPO@$REF"
  if command -v git >/dev/null 2>&1 && git clone -q --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$TMP/src" 2>/dev/null; then
    SRC="$TMP/src"
  elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    mkdir -p "$TMP/src"
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz" | tar -xz --strip-components=1 -C "$TMP/src" || die "Could not download $REPO@$REF"
    SRC="$TMP/src"
  else
    die "Need git, or curl+tar, to fetch $REPO"
  fi
}

# Stable copy of the server for clients that reference it by absolute path.
install_runtime() {
  ensure_src
  say "Installing runtime into $RUNTIME"
  rm -rf "$RUNTIME.new"
  mkdir -p "$RUNTIME.new"
  cp -R "$SRC/bin" "$SRC/src" "$SRC/examples" "$SRC/package.json" "$RUNTIME.new/"
  rm -rf "$RUNTIME"
  mv "$RUNTIME.new" "$RUNTIME"
}

register() { # register <target> <scope>
  node "$RUNTIME/bin/computer-skills.js" install-config --target "$1" --scope "$2" --server-path "$RUNTIME/bin/computer-skills.js"
}

copy_tree() { # copy_tree <src-dir> <dest-dir>
  mkdir -p "$2"
  cp -R "$1/." "$2/"
  echo "    + $2"
}

remove_listed() { # remove files present in <src-dir> from <dest-dir>
  local f
  for f in "$1"/*; do
    [ -e "$2/$(basename "$f")" ] && rm -rf "$2/$(basename "$f")" && echo "    - $2/$(basename "$f")"
  done
  return 0
}

# ---- Claude Code -------------------------------------------------------------
claude_scope() { [ "$SCOPE" = "project" ] && echo project || echo user; }
claude_root() { [ "$SCOPE" = "project" ] && echo "$PWD/.claude" || echo "$HOME/.claude"; }

install_claude() {
  if [ "$FORCE_COPY" -eq 0 ] && command -v claude >/dev/null 2>&1; then
    local source_arg
    if find_local_src; then source_arg="$SRC"; else source_arg="$REPO"; fi
    say "Installing with Claude Code's plugin installer (scope: $(claude_scope))"
    claude plugin marketplace add "$source_arg" || warn "marketplace add reported an error (it may already be added); continuing"
    claude plugin install "$PLUGIN@$MARKETPLACE" --scope "$(claude_scope)" \
      || die "claude plugin install failed. Inside Claude Code run:  /plugin marketplace add $REPO   then   /plugin install $PLUGIN@$MARKETPLACE"
    say "Done. Restart Claude Code (or /reload-plugins). Check with /mcp (computer-skills) and run /computer-skills:computer-doctor."
  else
    [ "$FORCE_COPY" -eq 1 ] || warn "'claude' CLI not found; registering the MCP server and copying the skill instead."
    install_runtime
    local root; root="$(claude_root)"
    copy_tree "$SRC/skills/computer-skills" "$root/skills/computer-skills"
    mkdir -p "$root/agents" && cp "$SRC"/agents/*.md "$root/agents/" && echo "    + $root/agents"
    mkdir -p "$root/commands" && cp "$SRC"/commands/*.md "$root/commands/" && echo "    + $root/commands"
    register claude "$SCOPE" || warn "Register manually: claude mcp add --scope user computer-skills -- node $RUNTIME/bin/computer-skills.js serve"
    say "Done. Restart Claude Code. For the managed plugin install later: /plugin marketplace add $REPO && /plugin install $PLUGIN@$MARKETPLACE"
  fi
}

uninstall_claude() {
  if command -v claude >/dev/null 2>&1; then
    claude plugin uninstall "$PLUGIN@$MARKETPLACE" --scope "$(claude_scope)" 2>/dev/null || true
    claude plugin marketplace remove "$MARKETPLACE" 2>/dev/null || true
    claude mcp remove computer-skills --scope user 2>/dev/null || true
  fi
  local root; root="$(claude_root)"
  rm -rf "$root/skills/computer-skills"
  rm -f "$root/agents/computer-operator.md" "$root/agents/app-explorer.md"
  rm -f "$root/commands/computer-doctor.md" "$root/commands/computer-workflows.md" "$root/commands/operate.md"
  say "Removed Claude Code integration"
}

# ---- OpenCode ----------------------------------------------------------------
opencode_root() { [ "$SCOPE" = "project" ] && echo "$PWD/.opencode" || echo "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"; }

install_opencode() {
  install_runtime
  local root; root="$(opencode_root)"
  say "Installing for OpenCode into $root"
  copy_tree "$SRC/skills/computer-skills" "$root/skills/computer-skills"
  mkdir -p "$root/agents" && cp "$SRC"/adapters/opencode/agents/*.md "$root/agents/" && echo "    + $root/agents"
  if [ "$SCOPE" = "project" ]; then register opencode project; else register opencode user; fi
  say "Done. Restart OpenCode. Use the 'computer-operator' agent, or ask for computer tasks (the computer-skills MCP tools are available to all agents)."
}

uninstall_opencode() {
  local root; root="$(opencode_root)"
  rm -rf "$root/skills/computer-skills"
  rm -f "$root/agents/computer-operator.md" "$root/agents/app-explorer.md"
  warn "Remove the \"computer-skills\" entry under \"mcp\" in your opencode.json manually (backup kept as .bak by the installer)."
}

# ---- Cursor ------------------------------------------------------------------
cursor_root() { [ "$SCOPE" = "project" ] && echo "$PWD/.cursor" || echo "$HOME/.cursor"; }

install_cursor() {
  install_runtime
  local root; root="$(cursor_root)"
  say "Installing for Cursor into $root"
  copy_tree "$SRC/skills/computer-skills" "$root/skills/computer-skills"
  mkdir -p "$root/agents" && cp "$SRC"/adapters/cursor/agents/*.md "$root/agents/" && echo "    + $root/agents"
  if [ "$SCOPE" = "project" ]; then
    mkdir -p "$root/rules" && cp "$SRC"/adapters/cursor/rules/*.mdc "$root/rules/" && echo "    + $root/rules"
  else
    warn "Cursor rules are project-scoped; re-run with --project inside a repo to add the rule."
  fi
  register cursor "$SCOPE"
  say "Done. Restart Cursor, then enable the computer-skills server under Settings → MCP."
}

uninstall_cursor() {
  local root; root="$(cursor_root)"
  rm -rf "$root/skills/computer-skills"
  rm -f "$root/agents/computer-operator.md" "$root/agents/app-explorer.md" "$root/rules/computer-skills.mdc"
  warn "Remove the \"computer-skills\" entry from $root/mcp.json manually (backup kept as .bak by the installer)."
}

# ---- dispatch ----------------------------------------------------------------
run_target() {
  if [ "$UNINSTALL" -eq 1 ]; then "uninstall_$1"; else "install_$1"; fi
}

if [ "$UNINSTALL" -eq 0 ]; then check_node; install_os_deps; fi
case "$TARGET" in
  all) for t in claude opencode cursor; do run_target "$t"; done ;;
  *) run_target "$TARGET" ;;
esac
[ "$UNINSTALL" -eq 0 ] && say "Diagnostics: node \"${RUNTIME}/bin/computer-skills.js\" doctor  (or /computer-skills:computer-doctor in Claude Code)"
exit 0
