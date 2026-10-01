import path from 'node:path';
import fsp from 'node:fs/promises';
import { defineAdapter } from '../adapter.js';
import { run } from '../../core/exec.js';
import { ToolError, ErrorCode } from '../../core/errors.js';
import { truncateMiddle } from '../../core/util.js';

export const vscode = defineAdapter({
  id: 'vscode',
  name: 'Visual Studio Code',
  aliases: ['vs code', 'code', 'visual studio code'],
  categories: ['ide', 'editor'],
  locate: {
    linux: { executables: ['code', 'code-insiders', 'codium'], desktopIds: ['code', 'code-insiders', 'codium', 'com.visualstudio.code'] },
    macos: { bundleNames: ['Visual Studio Code.app'], paths: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'] },
    windows: { executables: ['code.cmd', 'Code.exe'], paths: ['%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe'] },
  },
  window: { titlePattern: 'Visual Studio Code|VSCodium' },
  version: { args: ['--version'], pattern: '^(\\d+\\.\\d+\\.\\d+)' },
  launchArgs: ({ params }) => [...(params.newWindow ? ['--new-window'] : []), ...(params.goto ? ['--goto', params.goto] : []), ...(params.path ? [params.path] : [])],
  scripting: {
    language: 'cli',
    description: 'Runs the `code` CLI: {"args": ["--list-extensions"]} or {"args": ["--goto", "file.ts:10:5"]}. Installing extensions is a high-risk action.',
    async run(ctx, { args = [], timeoutMs = 60000 }) {
      const r = await run(ctx.executable, args, { timeoutMs, signal: ctx.signal });
      return { ok: r.code === 0, exit_code: r.code, stdout: truncateMiddle(r.stdout, 20000).text, stderr: truncateMiddle(r.stderr, 4000).text };
    },
  },
  knowledge: {
    shortcuts: {
      'command palette': 'mod+shift+p',
      'quick open file': 'mod+p',
      'go to line': 'ctrl+g',
      'toggle terminal': 'ctrl+`',
      'save': 'mod+s',
      'save all': 'mod+alt+s',
      'find in files': 'mod+shift+f',
      'toggle sidebar': 'mod+b',
      'close editor': 'mod+w',
    },
    tips: ['The command palette (mod+shift+p) reaches every command by name — prefer it over menus.', 'Prefer editing files directly over typing into the editor UI.'],
  },
});

export const godot = defineAdapter({
  id: 'godot',
  name: 'Godot Engine',
  aliases: ['godot', 'godot engine', 'godot4'],
  categories: ['game-engine', 'ide'],
  locate: {
    linux: { executables: ['godot', 'godot4', 'Godot'], desktopIds: ['org.godotengine.Godot', 'godot'] },
    macos: { bundleNames: ['Godot.app'], paths: ['/Applications/Godot.app/Contents/MacOS/Godot'] },
    windows: { executables: ['godot.exe', 'Godot.exe'] },
  },
  window: { titlePattern: 'Godot' },
  version: { args: ['--version'], pattern: '^(\\d+\\.\\d+(?:\\.\\d+)?)' },
  launchArgs: ({ params }) => [...(params.project ? ['--path', params.project, '--editor'] : [])],
  scripting: {
    language: 'gdscript',
    description: 'Runs a GDScript (must `extends SceneTree` and call quit()) headless: `godot --headless [--path project] --script file.gd`. Or {"args": [...]} for raw CLI, e.g. ["--headless", "--path", "proj", "--export-release", "Linux", "out/game.x86_64"].',
    async run(ctx, { code, project, args, timeoutMs = 600000 }) {
      const exe = ctx.executable;
      let argv;
      if (args) argv = args;
      else {
        if (!code) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'code or args is required');
        await fsp.mkdir(ctx.paths.tmp, { recursive: true });
        const file = path.join(ctx.paths.tmp, `godot-${Date.now()}.gd`);
        await fsp.writeFile(file, String(code));
        argv = ['--headless', ...(project ? ['--path', project] : []), '--script', file];
      }
      const r = await run(exe, argv, { timeoutMs, signal: ctx.signal });
      return { ok: r.code === 0, exit_code: r.code, stdout: truncateMiddle(r.stdout, 20000).text, stderr: truncateMiddle(r.stderr, 6000).text };
    },
  },
  knowledge: {
    shortcuts: { 'run project': 'f5', 'run current scene': 'f6', 'stop': 'f8', 'save scene': 'mod+s', 'quick open': 'mod+shift+o', 'command palette': 'mod+shift+p' },
    tips: ['Project files (.tscn, .tres, .gd, project.godot) are text: editing them directly and re-opening is often more reliable than GUI work.', 'Exports need export templates installed and an export preset in export_presets.cfg.'],
  },
});

export const unity = defineAdapter({
  id: 'unity',
  name: 'Unity',
  aliases: ['unity editor', 'unity3d', 'unity hub'],
  categories: ['game-engine', 'ide'],
  locate: {
    linux: { executables: ['unity-editor', 'Unity', 'unityhub'], paths: ['~/Unity/Hub/Editor/*/Editor/Unity'] },
    macos: { bundleNames: ['Unity.app', 'Unity Hub.app'], paths: ['/Applications/Unity/Hub/Editor/*/Unity.app/Contents/MacOS/Unity'] },
    windows: { executables: ['Unity.exe'], paths: ['C:/Program Files/Unity/Hub/Editor/*/Editor/Unity.exe'] },
  },
  window: { titlePattern: 'Unity' },
  launchArgs: ({ params }) => (params.project ? ['-projectPath', params.project] : []),
  scripting: {
    language: 'csharp',
    description: 'Batch mode: {"project": "path", "method": "Namespace.Class.StaticMethod"} runs `Unity -batchmode -quit -nographics -projectPath p -executeMethod m -logFile -`. The method must exist in an Editor script inside the project.',
    async run(ctx, { project, method, args = [], timeoutMs = 1800000 }) {
      if (!project || !method) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'project and method are required');
      const r = await run(ctx.executable, ['-batchmode', '-quit', '-nographics', '-projectPath', project, '-executeMethod', method, '-logFile', '-', ...args], { timeoutMs, signal: ctx.signal });
      return { ok: r.code === 0, exit_code: r.code, log: truncateMiddle(r.stdout + r.stderr, 30000).text };
    },
  },
  knowledge: {
    shortcuts: { play: 'mod+p', pause: 'mod+shift+p', save: 'mod+s', 'build settings': 'mod+shift+b' },
    tips: ['Only one Unity editor can open a project at a time: batch mode fails while the GUI has it open.', 'Editor scripts must live under an Assets/**/Editor/ folder.'],
  },
});

export const robloxStudio = defineAdapter({
  id: 'roblox-studio',
  name: 'Roblox Studio',
  aliases: ['roblox', 'robloxstudio'],
  categories: ['game-engine', 'ide'],
  locate: {
    macos: { bundleNames: ['RobloxStudio.app'] },
    windows: { executables: ['RobloxStudioBeta.exe'], paths: ['%LOCALAPPDATA%/Roblox/Versions/*/RobloxStudioBeta.exe'] },
  },
  window: { titlePattern: 'Roblox Studio' },
  knowledge: {
    shortcuts: { 'play': 'f5', 'run': 'f8', 'stop': 'shift+f5', 'save': 'mod+s', 'publish': 'alt+p', 'command bar': 'View tab → Command Bar' },
    tips: [
      'There is no external scripting CLI. Inside Studio, the Command Bar (View → Command Bar) runs Luau in the edit context: click it, type code, press Enter.',
      'Studio requires login; if a sign-in window appears, stop and ask the user.',
      'Use Rojo (if installed) to sync files from disk into Studio instead of editing scripts through the GUI.',
    ],
    pitfalls: ['Publishing affects a live experience: always treat "Publish to Roblox" as a high-risk action.'],
  },
});

export const photoshop = defineAdapter({
  id: 'photoshop',
  name: 'Adobe Photoshop',
  aliases: ['photoshop', 'ps'],
  categories: ['graphics', 'image-editor'],
  locate: {
    macos: { bundleNames: ['Adobe Photoshop 2025.app', 'Adobe Photoshop 2024.app', 'Adobe Photoshop 2023.app'] },
    windows: { executables: ['Photoshop.exe'], paths: ['C:/Program Files/Adobe/Adobe Photoshop */Photoshop.exe'] },
  },
  window: { titlePattern: 'Photoshop' },
  scripting: {
    language: 'extendscript',
    description: 'Runs ExtendScript (JavaScript) inside a running Photoshop: via COM (Windows) or AppleScript `do javascript` (macOS). Example: app.activeDocument.saveAs(new File("/tmp/x.png"), new PNGSaveOptions()).',
    async run(ctx, { code, timeoutMs = 300000 }) {
      if (!code) throw new ToolError(ErrorCode.INVALID_ARGUMENT, 'code is required');
      if (process.platform === 'win32') {
        const ps = `$ps = New-Object -ComObject Photoshop.Application; $r = $ps.DoJavaScript(@'\n${code}\n'@); Write-Output $r`;
        const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs, signal: ctx.signal });
        return { ok: r.code === 0, exit_code: r.code, result: r.stdout.trim(), stderr: r.stderr.trim() || undefined };
      }
      if (process.platform === 'darwin') {
        const appName = ctx.appName || 'Adobe Photoshop 2025';
        const r = await run('osascript', ['-e', `tell application "${appName}" to do javascript ${JSON.stringify(code)}`], { timeoutMs, signal: ctx.signal });
        return { ok: r.code === 0, exit_code: r.code, result: r.stdout.trim(), stderr: r.stderr.trim() || undefined };
      }
      throw new ToolError(ErrorCode.UNSUPPORTED, 'Photoshop is not available on Linux');
    },
  },
  knowledge: {
    shortcuts: { 'save': 'mod+s', 'save as': 'mod+shift+s', 'export as': 'mod+alt+shift+w', 'new': 'mod+n', 'open': 'mod+o', 'undo': 'mod+z', 'free transform': 'mod+t' },
    menus: { 'export png': ['File', 'Export', 'Quick Export as PNG'], 'export as': ['File', 'Export', 'Export As...'] },
    tips: ['Prefer ExtendScript via app_script for deterministic edits and exports.'],
  },
});

export const fileManager = defineAdapter({
  id: 'file-manager',
  name: 'File Manager',
  aliases: ['explorer', 'finder', 'nautilus', 'dolphin', 'files', 'thunar', 'nemo', 'file explorer'],
  categories: ['system', 'files'],
  locate: {
    linux: { executables: ['nautilus', 'dolphin', 'thunar', 'nemo', 'pcmanfm', 'caja'], desktopIds: ['org.gnome.Nautilus', 'org.kde.dolphin', 'thunar', 'nemo'] },
    macos: { bundleNames: ['Finder.app'], paths: ['/System/Library/CoreServices/Finder.app'] },
    windows: { executables: ['explorer.exe'] },
  },
  window: { titlePattern: 'Files|Finder|File Explorer|Dolphin|Nautilus|Thunar' },
  knowledge: {
    shortcuts: { 'go to path (GTK/Nautilus)': 'mod+l', 'go to folder (Finder)': 'meta+shift+g', 'address bar (Explorer)': 'alt+d', 'new folder': 'mod+shift+n', 'rename': 'f2 (Finder: enter)', 'show hidden files': 'ctrl+h (GTK) / meta+shift+. (Finder)' },
    tips: ['For file operations prefer terminal_run (or direct filesystem edits) over the GUI; use the file manager only when the user wants to see something, or to reveal a file (app action "open" with reveal=true).'],
  },
});

export const terminalApp = defineAdapter({
  id: 'terminal',
  name: 'Terminal Emulator',
  aliases: ['terminal', 'console', 'iterm', 'iterm2', 'gnome-terminal', 'konsole', 'windows terminal', 'wt', 'xterm'],
  categories: ['system', 'terminal'],
  locate: {
    linux: { executables: ['gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'wezterm', 'xterm'], desktopIds: ['org.gnome.Terminal', 'org.kde.konsole'] },
    macos: { bundleNames: ['iTerm.app', 'Terminal.app'], paths: ['/System/Applications/Utilities/Terminal.app'] },
    windows: { executables: ['wt.exe', 'powershell.exe', 'cmd.exe'] },
  },
  window: { titlePattern: 'Terminal|Konsole|iTerm|PowerShell|Command Prompt|xterm|Alacritty|kitty|WezTerm' },
  knowledge: {
    tips: [
      'To run commands, use terminal_run / terminal_session instead of typing into a terminal window — you get exit codes and clean output.',
      'Open a visible terminal only when the user needs to see or interact with it.',
    ],
  },
});
