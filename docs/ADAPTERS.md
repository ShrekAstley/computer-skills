# Writing application adapters

An adapter teaches computer-skills about one application: how to find and launch it, how to recognise its windows, how to read its version, how to drive it through a native scripting interface, and curated knowledge (shortcuts, menus, tips, pitfalls). **Adapters are optional** — any app can be operated generically and learned through workflows. Write one when an app has a scripting/CLI interface or knowledge that every user benefits from.

## Where

- Built-in: `src/apps/adapters/*.js`, registered in `src/apps/registry.js` (`BUILTIN_ADAPTERS`).
- Personal (no fork needed): `~/.computer-skills/adapters/<name>.js` (ES module) — loaded at server start. Default-export a plain object of the shape below; no imports are required (`ctx.run` is provided for running commands).

## Shape

```js
export default {
  id: 'krita',                         // slug used in workflow ids and app_script
  name: 'Krita',
  aliases: ['krita painting'],
  categories: ['graphics'],
  locate: {                            // how to find the executable per OS
    linux: { executables: ['krita'], desktopIds: ['org.kde.krita'] },
    macos: { bundleNames: ['krita.app'] },
    windows: { executables: ['krita.exe'], paths: ['C:/Program Files/Krita (x64)/bin/krita.exe'] },  // '*' globs allowed
  },
  window: { titlePattern: 'Krita' },   // regex to recognise its windows
  version: { args: ['--version'], pattern: 'krita\\s+([\\d.]+)' },
  launchArgs: ({ params }) => (params.file ? [params.file] : []),   // app launch params → argv
  scripting: {                          // optional: exposed through app_script
    language: 'cli',
    description: 'Exports a .kra to PNG headless: {"file": "in.kra", "options": {"output": "out.png"}}',
    async run(ctx, { file, output, timeoutMs = 120000 }) {
      // ctx: { executable, paths, signal, appName, run(cmd, args, opts), launch(args) }
      const r = await ctx.run(ctx.executable, [file, '--export', '--export-filename', output], { timeoutMs, signal: ctx.signal });
      return { ok: r.code === 0, exit_code: r.code, stderr: r.stderr.slice(-2000) };
    },
  },
  knowledge: {
    shortcuts: { 'save': 'mod+s', 'export': 'mod+shift+e' },
    menus: { 'export': ['File', 'Export...'] },
    tips: ['Use app_script for exports; the GUI export dialog has many options.'],
    verification: ['After export the output file exists and has a non-zero size.'],
    pitfalls: ['Opening very large canvases can take a minute: wait for the window title to show the file name.'],
  },
};
```

Built-in adapters wrap the object in `defineAdapter(...)` from `src/apps/adapter.js` (fills defaults) and may import helpers from `src/core/`.

## Guidelines

- `scripting.run` must return `{ ok: boolean, ... }`; `ok: false` fails workflow steps automatically. Include the tail of stderr/stdout so agents can diagnose.
- Respect `ctx.signal` (cancellation) and timeouts; never block forever.
- Don't perform destructive operations implicitly. `app_script` classifies `code` for risk; if your adapter accepts other inputs that can delete or install things, document them so the risk is obvious.
- Keep knowledge factual and version-qualified ("4.x moved X to Y").
- Add a test (`test/unit/…`) for any parsing logic, and an example workflow in `examples/workflows/<adapter-id>/` if there's a canonical task.

## Supporting a new OS mechanism

Backends implement the contract in `src/platform/base.js`. To add, for example, KDE Wayland window control, extend `LinuxBackend.listWindows`/`windowAction` with a new branch (detect via environment variables or available CLIs), report it in `capabilities()`, and add parser unit tests with captured sample output (see `test/unit/parsers.test.js`).
