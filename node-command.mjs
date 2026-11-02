/**
 * node-command.mjs — how to run one of this project's .js files as a script.
 *
 * `process.execPath` is the trustworthy way to avoid a second `node` on PATH,
 * except inside Electron: there it is electron.exe, and `electron.exe
 * test-extension.mjs` does not run a test — it opens another copy of the app.
 * Every batch job started from the desktop window therefore sat on "verifying"
 * until its timeout with nothing ever written to its log. ELECTRON_RUN_AS_NODE
 * is the switch that makes that same binary behave as plain Node.
 */

/** { command, env } to pass to spawn/sync for `node some-file.mjs …`. */
export function nodeCommand() {
  const command = process.execPath
  if (!process.versions.electron) return { command, env: process.env }
  return { command, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}
