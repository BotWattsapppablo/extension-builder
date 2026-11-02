/**
 * make-exe.mjs — build "Yomi Builder.exe".
 *
 * Uses the C# compiler that already ships with Windows (.NET Framework), so
 * nothing is downloaded and the result is a small native launcher. It is not a
 * snapshot of the app: the exe finds the project folder and runs start-app.mjs,
 * so every code change you make is picked up the next time you double-click.
 *
 *   node make-exe.mjs            # build + drop a copy on the Desktop
 *   node make-exe.mjs --no-desktop
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, userInfo } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LAUNCHER_DIR = join(__dirname, 'launcher')
const BUILD_DIR = join(LAUNCHER_DIR, 'build')
const EXE_NAME = 'Yomi Builder.exe'
const ICON = join(BUILD_DIR, 'app-icon.ico')
const ARTWORK = join(__dirname, 'app', 'icon.png')

function findCsc() {
  const root = 'C:\\Windows\\Microsoft.NET\\Framework64'
  for (const dir of readdirSync(root).sort().reverse()) {
    const p = join(root, dir, 'csc.exe')
    if (existsSync(p)) return p
  }
  throw new Error('csc.exe (the .NET Framework compiler) was not found in ' + root)
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8' }).trim()
}

const csc = findCsc()
console.log('compiler: ' + csc)
mkdirSync(BUILD_DIR, { recursive: true })

// 1. icon
run(csc, ['/nologo', '/target:exe', '/out:' + join(BUILD_DIR, 'IconTool.exe'), '/r:System.Drawing.dll', join(LAUNCHER_DIR, 'IconTool.cs')])
console.log('icon:     ' + run(join(BUILD_DIR, 'IconTool.exe'), [ICON, ARTWORK]))
copyFileSync(ICON, join(__dirname, 'app', 'icon.ico'))

// 2. launcher
const exe = join(__dirname, EXE_NAME)
run(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/win32icon:' + ICON,
  '/out:' + exe,
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  join(LAUNCHER_DIR, 'Launcher.cs')
])
console.log('built:    ' + exe + ' (' + (statSync(exe).size / 1024).toFixed(1) + ' KB)')

// 3. a copy on the Desktop that knows where the project lives
if (!process.argv.includes('--no-desktop')) {
  const desktops = [
    join(homedir(), 'OneDrive', 'Desktop'),
    join(homedir(), 'Desktop'),
    join(homedir(), 'OneDrive', 'Bureau'),
    join(homedir(), 'Bureau')
  ].filter(existsSync)
  if (desktops.length === 0) {
    console.log('desktop:  no Desktop folder found — skipped')
  } else {
    const target = join(desktops[0], EXE_NAME)
    copyFileSync(exe, target)
    writeFileSync(join(desktops[0], 'builder.path'), __dirname, 'utf-8')
    console.log('desktop:  ' + target)
  }
}

console.log('\nDouble-click "' + EXE_NAME + '" to open the builder.')
