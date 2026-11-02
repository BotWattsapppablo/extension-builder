/**
 * main.mjs — Electron main process for the builder app.
 *
 * The window is only a view: it pastes URLs, and this process runs batch.mjs
 * (the same engine the CLI uses) and streams every job's status and log back.
 */
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let win = null
let current = null // { batch, total }

async function engine() {
  // Imported lazily so the window paints before the builder modules load.
  return import('../batch.mjs')
}

function counts() {
  const c = { total: 0, queued: 0, running: 0, testing: 0, done: 0, warn: 0, failed: 0, human: 0, stopped: false }
  if (!current) return c
  const jobs = current.batch.live()
  c.total = jobs.length
  for (const j of jobs) {
    c[j.status] = (c[j.status] || 0) + 1
    if (j.needsHuman) c.human++
  }
  c.stopped = !!current.stopped
  return c
}

function send(kind, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('builder:event', { kind, payload, counts: counts() })
}

function createWindow() {
  const icon = join(__dirname, 'icon.ico')
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0d0d12',
    title: 'Yomi Builder',
    autoHideMenuBar: true,
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.loadFile(join(__dirname, 'index.html'))
}

ipcMain.handle('batch:start', async (_e, { text, concurrency, smoke }) => {
  const { runBatch, parseUrlList, MAX_CONCURRENCY } = await engine()
  if (current && !current.finished) {
    return { ok: false, error: 'A batch is already running.' }
  }
  const urls = parseUrlList(text)
  if (urls.length === 0) return { ok: false, error: 'No usable URLs found. Put one URL on each line.' }

  const batch = runBatch(urls, {
    concurrency,
    smoke,
    onEvent: (kind, payload) => send(kind, payload)
  })
  current = { batch, finished: false, stopped: false }
  batch.done
    .then(() => { current.finished = true; send('finished', null) })
    .catch((err) => { current.finished = true; send('fatal', String(err?.message || err)) })

  send('started', { accepted: urls.length })
  return { ok: true, accepted: urls.length, capped: Math.min(MAX_CONCURRENCY, concurrency) }
})

ipcMain.handle('batch:stop', async () => {
  if (!current || current.finished) return { ok: false }
  current.stopped = true
  current.batch.stop()
  send('stopped', null)
  return { ok: true }
})

ipcMain.handle('batch:lines', async (_e, id) => {
  if (!current) return []
  return current.batch.lines(id)
})

ipcMain.handle('batch:snapshot', async () => {
  if (!current) return { jobs: [], counts: counts() }
  return { jobs: current.batch.live(), counts: counts() }
})

ipcMain.handle('app:limits', async () => {
  const { MAX_CONCURRENCY, DEFAULT_CONCURRENCY } = await engine()
  return { max: MAX_CONCURRENCY, defaultConcurrency: DEFAULT_CONCURRENCY }
})

ipcMain.handle('app:openOutput', async () => {
  const { OUTPUT_DIR } = await import('../auto-build.mjs')
  const result = await shell.openPath(OUTPUT_DIR)
  if (result) dialog.showErrorBox('Could not open folder', result)
  return OUTPUT_DIR
})

ipcMain.handle('app:reveal', async (_e, file) => {
  const { OUTPUT_DIR } = await import('../auto-build.mjs')
  // Only ever reveal something this app generated, never an arbitrary path.
  const inside = typeof file === 'string' && resolve(file).startsWith(resolve(OUTPUT_DIR) + sep)
  if (inside) shell.showItemInFolder(file)
  return inside
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
