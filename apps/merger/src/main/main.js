const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createStore } = require('@mkv-tools/core/src/store');
const { identifyTracks } = require('@mkv-tools/core/src/mkvmergeService');
const mkvmergeSetup = require('@mkv-tools/core/src/mkvmergeSetup');
const { produce, cancel, checkSync } = require('./mergeService');

const store = createStore('.mkv-merger-settings.json');

const DEFAULTS = {
  outputPath: path.join(os.homedir(), 'Movies'),
  onFileExists: 'rename'
};

let mainWindow;
let merging = false;
let sleepBlockerId = null;

function blockSleep() {
  if (sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
}
function unblockSleep() {
  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 720, minWidth: 700, minHeight: 520,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  const toolsDir = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  mkvmergeSetup.setToolsDir(toolsDir);
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Settings ────────────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = store.get(k, DEFAULTS[k]);
  return s;
});
ipcMain.handle('save-settings', (_, settings) => {
  Object.entries(settings).forEach(([k, v]) => store.set(k, v));
  return true;
});

// ── Tools check ─────────────────────────────────────────────────────────────────
ipcMain.handle('get-tools-status', async () => {
  try {
    const p = await mkvmergeSetup.findMkvmerge();
    return { mkvmerge: !!p };
  } catch { return { mkvmerge: false }; }
});

// ── File pickers ─────────────────────────────────────────────────────────────────
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: store.get('outputPath', DEFAULTS.outputPath)
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('choose-sources', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'ts', 'm2ts'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

// ── Identify source tracks ────────────────────────────────────────────────────────
ipcMain.handle('identify-source', async (_, file) => {
  try {
    const tracks = await identifyTracks(file, (msg) => {
      mainWindow.webContents.send('log', msg);
    });
    const sync = checkSync([{ tracks }]);
    return { ok: true, tracks, file };
  } catch (err) {
    return { ok: false, error: err.message, file };
  }
});

// ── Merge ────────────────────────────────────────────────────────────────────────
ipcMain.handle('merge', async (_, plan) => {
  if (merging) return { ok: false, error: 'Already merging' };
  merging = true;
  blockSleep();
  try {
    await produce({
      plan,
      onProgress: (pct) => mainWindow.webContents.send('progress', pct),
      onLog:      (msg) => mainWindow.webContents.send('log', msg)
    });
    mainWindow.webContents.send('merge-complete', { output: plan.output });
    return { ok: true };
  } catch (err) {
    mainWindow.webContents.send('merge-error', err.message);
    return { ok: false, error: err.message };
  } finally {
    merging = false;
    unblockSleep();
  }
});

ipcMain.handle('cancel', () => {
  cancel();
  merging = false;
  unblockSleep();
  return true;
});

// ── Shell ────────────────────────────────────────────────────────────────────────
ipcMain.handle('open-url', (_, url) => shell.openExternal(url));
