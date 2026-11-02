/**
 * start-app.mjs — launch the desktop builder without installing Electron twice.
 *
 * Looks for an Electron install in this folder first, then falls back to the one
 * already present in the parent MihonPC project.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function findElectronBinary() {
  for (const spec of ['electron', join(__dirname, '..', 'node_modules', 'electron')]) {
    try {
      const resolved = require(spec)
      if (typeof resolved === 'string' && existsSync(resolved)) return resolved
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

const binary = findElectronBinary()
if (!binary) {
  console.error('\nElectron was not found. Install it once with:\n\n    npm install --save-dev electron\n')
  process.exit(1)
}

const child = spawn(binary, [join(__dirname, 'app')], { stdio: 'inherit', env: cleanEnv() })
child.on('exit', (code) => process.exit(code ?? 0))

// Electron refuses to open a window when ELECTRON_RUN_AS_NODE is set — even to
// an empty string — so the variable has to be removed, not blanked.
function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
