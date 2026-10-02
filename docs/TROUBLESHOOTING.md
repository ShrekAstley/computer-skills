# Troubleshooting

Start with `computer-skills doctor` (or `/computer-skills:computer-doctor` in Claude Code). Server logs: `~/.computer-skills/logs/server.log` (set `COMPUTER_SKILLS_LOG_LEVEL=debug` or `COMPUTER_SKILLS_DEBUG=1` for backend command traces). Policy decisions: `computer-skills audit`.

| Symptom | Cause / fix |
|---------|-------------|
| `/mcp` shows computer-skills failed / not connected | Node.js ≥ 18 must be on the `PATH` of the client. Check `node --version` in the same environment. For Cursor/OpenCode the installer writes an absolute Node path; re-run it after upgrading Node via nvm. Run `node <plugin>/bin/computer-skills.js doctor` directly to see errors. |
| macOS: blank/wallpaper screenshots, empty window titles | Grant **Screen Recording** to the host app (Terminal/iTerm/VS Code/Cursor/Claude), then restart it. |
| macOS: `PERMISSION_DENIED … assistive access` | Grant **Accessibility** to the host app. |
| Windows: clicks/typing don't reach an app | The app runs as administrator; run the agent's host elevated too, or avoid the app. |
| Windows: first call slow (~1–2 s) | The PowerShell helper compiles its Win32 bindings once per server start; later calls take milliseconds. |
| Linux: `DEPENDENCY_MISSING xdotool` / screenshots fail | Install the X11 tools: `sudo apt install xdotool wmctrl x11-utils imagemagick xclip tesseract-ocr`. |
| Linux Wayland: no window list / input | Use sway or Hyprland, install `grim`, `ydotool` (+ `ydotoold`), `wtype`; or run the app under XWayland. GNOME/KDE Wayland don't expose window control. |
| `ui_inspect` returns an empty tree | The app draws its own UI (Blender, games, some Electron/Java apps) or accessibility is off (Linux: install `python3-gi gir1.2-atspi-2.0`; Qt: `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`; Electron: `--force-renderer-accessibility`). Use OCR (`screen_text`, `ui_find method=ocr`). |
| OCR misses text | Increase `ocr.upscale` to 2 for tiny anti-aliased fonts; install language packs and set `ocr.language` (e.g. `eng+deu`); scope to a window/region. |
| `CONFIRMATION_REQUIRED` keeps coming back | Tokens are single-use and bound to identical arguments. If your client supports elicitation you'll get an approval prompt instead. Or raise the level if appropriate. |
| Everything is refused with `KILL_SWITCH` | `computer-skills resume` (removes `~/.computer-skills/STOP`), and move the mouse away from the top-left corner. |
| A built-in workflow seems outdated | Your saved version (user/project scope) overrides it; `workflow_versions` lists versions; `workflow_versions restore` rolls back. |
| Blender glTF export fails with `No module named 'numpy'` | Distribution-packaged Blender lacks numpy. Export `.obj`/`.fbx`/`.stl`, or use the blender.org build. |
| Blender Cycles fails with `Build without OpenImageDenoiser` | Disable denoising (`scene.cycles.use_denoising = False`); the built-in render workflow does this. |
