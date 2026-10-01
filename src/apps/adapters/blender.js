import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineAdapter } from '../adapter.js';
import { run } from '../../core/exec.js';
import { ToolError, ErrorCode } from '../../core/errors.js';
import { truncateMiddle } from '../../core/util.js';

export default defineAdapter({
  id: 'blender',
  name: 'Blender',
  aliases: ['blender3d', 'blender 3d'],
  categories: ['3d', 'graphics', 'animation'],
  locate: {
    linux: { executables: ['blender'], desktopIds: ['blender', 'org.blender.Blender'], paths: ['/snap/bin/blender', '/opt/blender/blender'] },
    macos: { bundleNames: ['Blender.app'], paths: ['/Applications/Blender.app/Contents/MacOS/Blender'] },
    windows: { executables: ['blender.exe'], paths: ['C:/Program Files/Blender Foundation/*/blender.exe'] },
  },
  window: { titlePattern: '(?:^|\\s|\\[)Blender(?:\\s|$|\\])|\\.blend' },
  version: { args: ['--version'], pattern: 'Blender\\s+(\\d+\\.\\d+(?:\\.\\d+)?)' },
  launchArgs: ({ params }) => (params.file ? [params.file] : []),
  scripting: {
    language: 'python',
    description:
      'Runs Python with the bpy API. background=true (default) runs headless: `blender [file] --background --python <script>` and returns stdout — ideal for generating scenes, importing/exporting, rendering. background=false opens the GUI and runs the script at startup.',
    async run(ctx, { code, file, background = true, timeoutMs = 600000, factoryStartup = false, extraArgs = [] }) {
      const exe = ctx.executable;
      if (!exe) throw new ToolError(ErrorCode.NOT_FOUND, 'Blender executable not found', { hint: 'Install Blender or pass the executable path in app_script.executable.' });
      await fsp.mkdir(ctx.paths.tmp, { recursive: true });
      const script = path.join(ctx.paths.tmp, `blender-${Date.now()}.py`);
      // --python-exit-code makes an uncaught Python exception exit non-zero.
      await fsp.writeFile(script, String(code));
      const args = [];
      if (file) args.push(file);
      if (factoryStartup) args.push('--factory-startup');
      if (background) {
        args.push('--background', '--python-exit-code', '1', '--python', script, ...extraArgs);
        const r = await run(exe, args, { timeoutMs, signal: ctx.signal });
        fsp.rm(script, { force: true }).catch(() => {});
        const stdout = truncateMiddle(r.stdout, 20000);
        return { ok: r.code === 0 && !r.timedOut, exit_code: r.code, stdout: stdout.text, stderr: truncateMiddle(r.stderr, 8000).text, timed_out: r.timedOut || undefined, mode: 'background' };
      }
      args.push('--python', script, ...extraArgs);
      const res = await ctx.launch(args);
      return { ok: true, mode: 'gui', ...res, note: 'Script runs once Blender has started; verify the result in the UI or via files it writes.' };
    },
  },
  knowledge: {
    shortcuts: {
      'save': 'mod+s',
      'save as': 'mod+shift+s',
      'open': 'mod+o',
      'new file': 'mod+n',
      'render image': 'f12',
      'render animation': 'mod+f12',
      'add object menu (3D viewport)': 'shift+a',
      'delete selected (3D viewport)': 'x then confirm, or delete',
      'search menu / operator search': 'f3',
      'toggle edit/object mode': 'tab',
      'grab / rotate / scale': 'g / r / s',
      'frame selected': 'numpad . (view selected)',
      'quit': 'mod+q',
    },
    menus: {
      'import': ['File', 'Import'],
      'export': ['File', 'Export'],
      'save render image': ['Image', 'Save As'],
      'render image': ['Render', 'Render Image'],
      'preferences': ['Edit', 'Preferences'],
    },
    tips: [
      'Prefer app_script (bpy, background mode) for anything that can be expressed in Python: creating geometry, terrain (bpy.ops.mesh.landscape_add requires the A.N.T. Landscape add-on; or displace a subdivided plane with a noise texture), materials, import/export (bpy.ops.import_scene.*, bpy.ops.export_scene.*/wm.obj_export, wm.usd_export), rendering (bpy.context.scene.render.filepath + bpy.ops.render.render(write_still=True)), saving (bpy.ops.wm.save_as_mainfile(filepath=...)).',
      'Blender draws its own UI with OpenGL: there is no OS accessibility tree. In the GUI rely on screenshots, OCR, hotkeys and the F3 operator search (type the operator name and press Enter).',
      'Hotkeys act on the area under the mouse pointer: move the mouse over the 3D viewport before pressing viewport hotkeys.',
      'Exporter operator names changed across versions (e.g. 4.x uses bpy.ops.wm.obj_export; older uses bpy.ops.export_scene.obj). Check bpy.app.version first and record the version in learned workflows.',
      'Rendering with Cycles on CPU can be slow; for previews set scene.render.engine = "BLENDER_EEVEE_NEXT" (4.2+) or "BLENDER_EEVEE", and lower resolution_percentage.',
    ],
    verification: [
      'After saving: the .blend file exists and its modification time is recent.',
      'After export: the exported file exists with non-zero size; optionally re-import it in background mode and count objects.',
      'After rendering: the output image exists; screen_text can confirm the render window title.',
    ],
    pitfalls: ['A "Save changes before closing?" dialog appears on quit with unsaved changes.', 'File browser in Blender is not a native dialog: type the path into its path field (double-click the field, mod+a, type, Enter).'],
  },
});
