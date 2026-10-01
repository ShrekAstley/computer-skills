/**
 * Application adapters describe how to find, launch, recognise and (when the
 * app has one) script an application, plus curated knowledge the agent can
 * use before it has learned anything itself. Adapters are *optional*: any app
 * can be driven generically and learned through workflows.
 *
 * @typedef {object} AppAdapter
 * @property {string} id                       stable slug, e.g. "blender"
 * @property {string} name                     display name
 * @property {string[]} [aliases]              other names users say
 * @property {string[]} [categories]
 * @property {{linux?: Locator, macos?: Locator, windows?: Locator}} [locate]
 * @property {{titlePattern?: string, classPattern?: string}} [window]   recognise its windows
 * @property {{args: string[], pattern: string}} [version]               CLI version probe
 * @property {(opts: {params: object}) => string[]} [launchArgs]          extra CLI args for launch
 * @property {Scripting} [scripting]          native automation interface (far more reliable than GUI)
 * @property {Knowledge} [knowledge]          curated shortcuts, menus, tips
 *
 * @typedef {{executables?: string[], desktopIds?: string[], bundleNames?: string[], paths?: string[]}} Locator
 * @typedef {{language: string, description: string, run: (ctx: object, req: object) => Promise<object>}} Scripting
 * @typedef {{shortcuts?: Record<string,string>, menus?: Record<string,string[]>, tips?: string[], verification?: string[], pitfalls?: string[]}} Knowledge
 */

export function defineAdapter(a) {
  if (!a.id || !a.name) throw new Error('adapter needs id and name');
  return Object.freeze({ aliases: [], categories: [], locate: {}, knowledge: {}, ...a });
}
