# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Workflow documents carry their own `schema` version (currently 1).

## [Unreleased]

### Added
- Claude Code: `expert-workflow` is now a plugin dependency (installed automatically from this marketplace).
- Claude Code: `SessionStart` hook that, when Node.js 18+ is missing or too old, tells Claude why the computer tools are unavailable and how to fix it (silent otherwise).
- `/computer-skills:computer-doctor` diagnoses a server that failed to start.
- README: verified Claude Code install, team setup, update/uninstall and troubleshooting guide.

## [1.0.0] - 2026-10-01

### Added
- Dependency-free MCP server (stdio, protocol 2024-11-05 … 2025-06-18) with 28 tools: environment, terminal, sessions, processes, apps, app scripting, windows, screen capture, OCR, accessibility inspection/search/actions, menus, dialogs and file pickers, mouse, keyboard, clipboard, verification, diagnosis, workflow memory, app profiles, safety.
- OS backends: Linux (X11 via xdotool/wmctrl/xwininfo; Wayland via sway/Hyprland IPC, grim, ydotool/wtype; AT-SPI accessibility), macOS (CoreGraphics + System Events via JXA, Vision OCR, screencapture), Windows (persistent PowerShell helper: SendInput, Win32 windows, GDI capture, UI Automation, WinRT OCR).
- Safety: risk classifier for commands, UI targets, hotkeys and app scripts; restricted/normal/trusted levels; MCP elicitation and single-use confirmation tokens; protected paths; blocked apps; allow/deny patterns; kill switch; failsafe corner; audit log; projects can only tighten policy.
- Workflow memory: versioned JSON workflows with parameters, per-step expectations, retries/recovery, manual steps, failure modes; user/project/built-in scopes; confidence model (known/partial/unknown); runner with diagnosis and recovery guides; recorder that turns exploration into drafts; app profiles; stats overlay for built-ins.
- Adapters: Blender (bpy), Chrome/Chromium/Edge/Firefox (headless), VS Code, Godot, Unity, Roblox Studio, Photoshop, file managers, terminals; personal adapters from `~/.computer-skills/adapters`.
- Claude Code plugin (marketplace, skill, `computer-operator`/`app-explorer` subagents, slash commands), OpenCode and Cursor adapters, `install.sh`/`install.ps1`, CLI (`doctor`, `call`, `workflows`, `stop`/`resume`, `install-config`, …).
- Example workflows: Blender terrain scene + export, Blender render (headless and GUI), generic Save As, page to PDF, open URL, VS Code open folder, Godot export.
- Tests: unit suite (node:test) and integration suite (MCP over stdio, CLI, real X11 GUI automation under Xvfb).
