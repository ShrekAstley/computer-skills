# Platform notes

Run `env_inspect sections=["capabilities"]` (or `computer-skills doctor`) to see what works on the current machine and what to install.

## Windows

- Backend: one long-lived Windows PowerShell 5.1 helper (always present) with compiled Win32 bindings — `SendInput` for mouse/keyboard (Unicode typing), `EnumWindows`/`SetForegroundWindow` for windows, GDI capture, UI Automation for the accessibility tree/actions/menus, `Windows.Media.Ocr` for OCR. No installs required.
- The helper is DPI-aware: coordinates are physical pixels and match screenshots.
- Apps running elevated (as administrator) can't receive input from a non-elevated agent (UIPI) → `PERMISSION_DENIED`.
- Shells: `pwsh` (if installed) → `powershell` → `cmd`. Git Bash is used when requested with `shell: "bash"`.
- App discovery: Start menu apps (`Get-StartApps`, including Store apps launched via `shell:AppsFolder`) and the App Paths registry.

## macOS

- Backend: CoreGraphics events (via `osascript -l JavaScript`) for the mouse, System Events for keyboard/windows/accessibility/menu bar, `screencapture` for pixels, Vision for OCR. `cliclick` is used if installed.
- **Permissions:** the host app (Terminal/iTerm/VS Code/Cursor/Claude desktop) needs **Accessibility** and **Screen Recording** (System Settings → Privacy & Security). Without Screen Recording, screenshots show only the wallpaper and window titles are empty.
- Retina: screenshots are captured at pixel resolution; results report `scale` and input tools convert from `screenshot_id` coordinates automatically.
- `mod` = Cmd. Native file dialogs: `ui_dialog fill_path` uses Cmd+Shift+G.
- Menus are best driven with `ui_menu` (native menu bar).

## Linux

- **X11** (most capable): `xdotool` (input, focus), `wmctrl` (+`xwininfo` for exact geometry), ImageMagick `import`/`maim`/`scrot`/`xwd` for capture, `xclip`/`xsel` clipboard. Install: `sudo apt install xdotool wmctrl x11-utils imagemagick xclip tesseract-ocr`.
- **Wayland**: compositors restrict automation. Windows: sway (`swaymsg`) and Hyprland (`hyprctl`) are supported; GNOME/KDE expose no window API. Capture: `grim` (wlroots), `gnome-screenshot`, `spectacle`. Input: `ydotool` (needs the `ydotoold` daemon/uinput access) and `wtype` (keyboard). X11 apps under XWayland can still be driven with xdotool.
- Accessibility: AT-SPI via `python3-gi` + `gir1.2-atspi-2.0`. GTK apps expose it; Qt apps may need `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`; Electron apps need `--force-renderer-accessibility`.
- OCR: `tesseract-ocr` (+ language packs, e.g. `tesseract-ocr-deu`; set `ocr.language`).
- Headless servers / CI: run under `Xvfb` with a window manager (e.g. `openbox`) for GUI automation.

## All platforms

- Node.js ≥ 18 is required to run the MCP server.
- Moving the mouse to the top-left corner (0,0) aborts input actions (failsafe; disable with `safety.failsafeCorner: false`).
- `touch ~/.computer-skills/STOP` (or `computer-skills stop`) pauses all actions; `computer-skills resume` releases it.
