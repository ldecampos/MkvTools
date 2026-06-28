'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createStore } = require('@mkv-tools/core/src/store');
const { remuxService } = require('./remuxService');
const { tmdbService } = require('@mkv-tools/core/src/tmdbService');
const { jellyfinService } = require('@mkv-tools/core/src/jellyfinService');
const { guessFromFilename } = require('@mkv-tools/core/src/filenameParser');
const { FILE_VARIABLES, AUDIO_VARIABLES, SUBTITLE_VARIABLES, SERIES_VARIABLES, TRACK_VARIABLES, BUILTIN_PRESETS } = require('@mkv-tools/core/src/nameTemplate');
const { ALL_LANGS, VARIANT_MAP, variantsForLang } = require('@mkv-tools/core/src/langData');
const { createSettings } = require('@mkv-tools/core/src/settings');
const { computeOutput, uniqueName } = require('@mkv-tools/core/src/outputNaming');
const { getStrings, languageList, SUPPORTED } = require('./i18n');
const mkvmergeSetup = require('@mkv-tools/core/src/mkvmergeSetup');
const makemkvService = require('./makemkvService');

const ocrService = require('@mkv-tools/core/src/ocrService');
// Settings file shared with Merger; migrates automatically from the old name on first run
const store = createStore('.mkv-tools-settings.json', '.mkv-remuxer-settings.json');
// ripTempPath is Remuxer-only (disc ripping); everything else comes from the shared schema.
const settingsStore = createSettings(store, { ripTempPath: '' });
const DEFAULTS = settingsStore.DEFAULTS;

function detectOSLang() {
  try {
    const locale = (app.getLocale() || 'en').toLowerCase();
    const base = locale.split('-')[0];
    return SUPPORTED.includes(base) ? base : 'en';
  } catch (_) { return 'en'; }
}

let mainWindow;
let processing = false;
let cancelRequested = false;
let ripping = false;
let sleepBlockerId = null;

function blockSleep() {
  if (sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
}
function unblockSleep() {
  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId);
  sleepBlockerId = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 780, minWidth: 860, minHeight: 640,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f0f1a',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  const toolsDir = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  mkvmergeSetup.setToolsDir(toolsDir);
  makemkvService.setDataPath(app.getPath('userData'));
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Settings ───────────────────────────────────────────────────────────────────
function getSettings() {
  const s = settingsStore.getAll();
  if (!s.uiLang) s.uiLang = detectOSLang();
  return s;
}
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (_, settings) => {
  settingsStore.saveAll(settings);
  return true;
});
ipcMain.handle('get-meta', () => ({
  fileVariables: FILE_VARIABLES,
  trackVariables: TRACK_VARIABLES,
  audioVariables: AUDIO_VARIABLES,
  subtitleVariables: SUBTITLE_VARIABLES,
  seriesVariables: SERIES_VARIABLES,
  builtinPresets: BUILTIN_PRESETS,
  allLangs: ALL_LANGS,
  uiLanguages: languageList(),
  variantMap: VARIANT_MAP
}));
ipcMain.handle('get-strings', (_, lang) => getStrings(lang));
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], defaultPath: store.get('outputPath', DEFAULTS.outputPath) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('choose-files', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'ts', 'm2ts', 'mov'] }]
  });
  return r.canceled ? [] : r.filePaths;
});

// ── Analyze a file ──────────────────────────────────────────────────────────────
ipcMain.handle('analyze-file', async (_, filePath) => {
  const settings = getSettings();
  const guess = guessFromFilename(filePath);
  let media = null;
  let candidates = [];

  if (guess.type === 'series') {
    if (guess.title) {
      try { candidates = await tmdbService.searchTV(guess.title, settings.tmdbApiKey); media = candidates[0] || null; }
      catch (e) { sendLog(`TMDb: ${e.message}`, 'warn'); }
    }
    if (!media && guess.title) media = { id: null, type: 'series', title: guess.title, year: '', imdbId: null, posterPath: null };
    if (media) {
      media.season = guess.season;
      media.episode = guess.episode;
      if (media.id && settings.fetchEpisodeTitle) {
        const ep = await tmdbService.getEpisode(media.id, guess.season, guess.episode, settings.tmdbApiKey);
        media.episodeTitle = ep.episodeTitle;
        media.episodeImdbId = ep.episodeImdbId;
      }
    }
  } else {
    if (guess.title) {
      try {
        candidates = await tmdbService.search(guess.title, settings.tmdbApiKey);
        if (guess.year) media = candidates.find(c => c.year === guess.year) || candidates[0] || null;
        else media = candidates[0] || null;
      } catch (e) { sendLog(`TMDb: ${e.message}`, 'warn'); }
    }
    if (!media && (guess.title || guess.year)) media = { id: null, type: 'movie', title: guess.title, year: guess.year, imdbId: null, posterPath: null };
  }

  let tracks = [], fileTitle = '';
  try {
    const info = await remuxService.identifyTracks(filePath, () => {});
    tracks = info.tracks;
    fileTitle = info.title;
  } catch (err) {
    return { ok: false, error: err.message, filePath, guess };
  }

  const plan = remuxService.planTracks(tracks, settings);
  return { ok: true, filePath, guess, mediaType: guess.type, movie: media, candidates, tracks, fileTitle, plan };
});

ipcMain.handle('replan', async (_, { tracks, overrides }) => {
  const settings = getSettings();
  const plan = remuxService.planTracks(tracks, settings, overrides || {});
  const naturalPlan = remuxService.planTracks(tracks, settings, {});
  const natural = {};
  for (const p of naturalPlan) if (p.role !== 'video') natural[p.id] = !!p.keep;
  return { plan, natural };
});

ipcMain.handle('search-tv', async (_, arg) => {
  const key = store.get('tmdbApiKey', '');
  if (!key) return { noKey: true, results: [] };
  const query = typeof arg === 'string' ? arg : arg.query;
  const year = typeof arg === 'object' ? arg.year : undefined;
  try { return await tmdbService.searchTV(query, key, year); } catch (e) { return []; }
});
ipcMain.handle('get-episode', async (_, { tvId, season, episode }) => {
  const key = store.get('tmdbApiKey', '');
  if (!key) return { episodeTitle: '' };
  try { return await tmdbService.getEpisode(tvId, season, episode, key); } catch (e) { return { episodeTitle: '' }; }
});
ipcMain.handle('search-movie', async (_, arg) => {
  const key = store.get('tmdbApiKey', '');
  if (!key) return { noKey: true, results: [] };
  const query = typeof arg === 'string' ? arg : arg.query;
  const year = typeof arg === 'object' ? arg.year : undefined;
  try { return await tmdbService.search(query, key, year); } catch (e) { return []; }
});

// ── Process batch ──────────────────────────────────────────────────────────────
ipcMain.handle('process-batch', async (_, items) => {
  if (processing) return { error: 'Already processing' };
  processing = true;
  cancelRequested = false;
  blockSleep();
  runBatch(items).finally(() => { processing = false; cancelRequested = false; unblockSleep(); });
  return { started: true };
});
// Cancel: signal the batch loop to stop and kill the active mkvmerge. The
// runBatch() .finally() clears `processing`/sleep blocker once it actually
// exits, so a new batch cannot start while the old one is still unwinding.
ipcMain.handle('cancel', () => { cancelRequested = true; remuxService.cancel(); return true; });

async function runBatch(items) {
  const settings = getSettings();
  let done = 0;
  const plannedOutputs = new Set();

  for (const item of items) {
    if (cancelRequested) { sendLog('Cancelled — stopping batch', 'warn'); break; }
    const { filePath, movie } = item;
    const isSeries = movie && movie.type === 'series';
    try {
      sendLog(`Processing: ${path.basename(filePath)}`, 'info');

      let tracks = item.tracks;
      if (!tracks || !tracks.length) {
        const info = await remuxService.identifyTracks(filePath, m => sendLog(m, 'info'));
        tracks = info.tracks;
      }
      const plan = remuxService.planTracks(tracks, settings, item.overrides);
      logPlan(plan);

      let { output, fileTitle } = computeOutput(filePath, movie, settings, isSeries, plan);
      fs.mkdirSync(path.dirname(output), { recursive: true });

      const exists = () => fs.existsSync(output) || plannedOutputs.has(output);
      if (exists()) {
        const policy = settings.onFileExists || 'rename';
        if (policy === 'skip') {
          sendLog(`↷ Skipped (already exists): ${path.basename(output)}`, 'warn');
          sendItemDone(filePath, true); done++;
          sendProgress('__overall__', Math.round((done / items.length) * 100));
          continue;
        } else if (policy === 'rename') {
          output = uniqueName(output, plannedOutputs);
          sendLog(`Renamed to avoid overwrite: ${path.basename(output)}`, 'info');
        } else {
          sendLog(`Overwriting existing: ${path.basename(output)}`, 'warn');
        }
      }
      plannedOutputs.add(output);

      const convertedSubs = [];
      if (settings.ocrEnabled) {
        const mkvmergePath = remuxService.findMkvmerge();
        const pgsTracks = plan.filter(p => p.role === 'subtitles' && p.keep && /pgs|s_hdmv/i.test(p.codec || ''));
        for (const t of pgsTracks) {
          if (cancelRequested) break;
          try {
            sendLog(`OCR: Converting PGS track ${t.id} (${t.lang}) to SRT...`, 'info');
            const srt = await ocrService.convertPgsToSrt(filePath, t.id, {
              mkvmergePath,
              lang: t.lang,
              customTesseractPath: settings.ocrPath || '',
            }, frac => sendProgress(filePath, Math.round((frac || 0) * 100)));
            if (!srt.trim()) {
              sendLog(`OCR: Track ${t.id} produced no text — keeping PGS`, 'warn');
              continue;
            }
            const srtPath = path.join(os.tmpdir(), `mkvtools_ocr_${Date.now()}_${t.id}.srt`);
            fs.writeFileSync(srtPath, srt, 'utf8');
            convertedSubs.push({ originalTrackId: t.id, srtPath, track: t });
            sendLog(`OCR: Track ${t.id} → SRT (${t.lang})`, 'success');
          } catch (err) {
            sendLog(`OCR: Track ${t.id} failed — keeping PGS: ${err.message}`, 'warn');
          }
        }
      }

      await remuxService.produce({
        input: filePath, output, plan, fileTitle,
        movie, writeImdbTag: settings.writeImdbTag, embedCoverArt: settings.embedCoverArt,
        convertedSubs,
        onProgress: p => sendProgress(filePath, Math.round(p * 100)),
        onLog: m => sendLog(m, 'info')
      });

      for (const cs of convertedSubs) {
        try { fs.unlinkSync(cs.srtPath); } catch (_) {}
      }

      if (item.tmpDir) {
        try { fs.rmSync(item.tmpDir, { recursive: true, force: true }); sendLog(`Deleted temp rip folder: ${path.basename(item.tmpDir)}`, 'info'); }
        catch (_) {}
      }

      sendLog(`✓ Done: ${output}`, 'success');
      sendItemDone(filePath, true);
    } catch (err) {
      sendLog(`✗ Failed (${path.basename(filePath)}): ${err.message}`, 'error');
      sendItemDone(filePath, false);
    }
    done++;
    sendProgress('__overall__', Math.round((done / items.length) * 100));
  }

  if (settings.jellyfinEnabled) {
    await jellyfinService.refreshLibrary({ serverUrl: settings.jellyfinUrl, apiKey: settings.jellyfinApiKey, onLog: m => sendLog(m, 'info') });
  }

  const tt = getStrings(settings.uiLang);
  sendLog(tt.all_done || `Batch complete: ${done} file(s) processed`, 'success');
  if (mainWindow) mainWindow.webContents.send('batch-complete');
}

// ── Tools status ──────────────────────────────────────────────────────────────
ipcMain.handle('get-tools-status', async () => ({
  mkvmerge: mkvmergeSetup.getStatus(),
  makemkv: await makemkvService.getStatus(),
}));
ipcMain.handle('get-ocr-status', async () => {
  const settings = getSettings();
  return ocrService.getStatus(settings.ocrPath || '');
});
ipcMain.handle('ocr-convert', async (_, { filePath, trackId, lang }) => {
  const settings = getSettings();
  if (!settings.ocrEnabled) return { ok: false, error: 'OCR is disabled in settings' };
  const mkvmergePath = remuxService.findMkvmerge();
  try {
    mainWindow?.webContents.send('ocr-progress', { trackId, progress: 0 });
    const srt = await ocrService.convertPgsToSrt(filePath, trackId, {
      mkvmergePath,
      lang,
      customTesseractPath: settings.ocrPath || '',
    }, frac => {
      const progress = Math.round((frac || 0) * 100);
      mainWindow?.webContents.send('ocr-progress', { trackId, progress });
    });
    return { ok: true, srt };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('open-url', (_, url) => {
  const safe = [
    'https://mkvtoolnix.download', 'https://www.makemkv.com', 'https://forum.makemkv.com',
    'https://www.themoviedb.org', 'https://github.com/UB-Mannheim/tesseract',
  ];
  if (safe.some(s => url.startsWith(s))) shell.openExternal(url);
});

// ── Disc scanning ─────────────────────────────────────────────────────────────
ipcMain.handle('scan-disc', async () => {
  try {
    const status = await makemkvService.getStatus();
    if (!status.installed) return { ok: false, error: 'MakeMKV not installed. Install it from makemkv.com' };
    sendLog(`Scanning disc via: ${status.path}`, 'info');
    const discs = await makemkvService.listDiscs(status.path);
    sendLog(`Disc scan complete — found ${discs.length} disc(s)`, 'info');
    return { ok: true, discs };
  } catch (e) { sendLog(`Disc scan error: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
});

// ── Ripping ───────────────────────────────────────────────────────────────────
ipcMain.handle('rip-title', async (_, { discIndex, discTarget, titleId, media, auto }) => {
  if (ripping) return { ok: false, error: 'Already ripping' };
  const status = await makemkvService.getStatus();
  if (!status.installed) return { ok: false, error: 'MakeMKV not installed' };
  const settings = getSettings();
  const ripBase = settings.ripTempPath || path.join(app.getPath('userData'), 'rips');
  const tmpDir = path.join(ripBase, `rip-${Date.now()}`);
  ripping = true; blockSleep();
  runRip({ makemkvcon: status.path, discIndex, discTarget, titleId, tmpDir, media: media || null, auto: !!auto })
    .finally(() => { ripping = false; unblockSleep(); });
  return { ok: true, started: true };
});
ipcMain.handle('cancel-rip', () => { makemkvService.cancelRip(); ripping = false; unblockSleep(); return true; });

async function runRip({ makemkvcon, discIndex, discTarget, titleId, tmpDir, media, auto }) {
  try {
    let label = media ? `${media.title}${media.year ? ` (${media.year})` : ''}` : `title ${titleId}`;
    if (media && media.type === 'series' && media.season) label += ` S${String(media.season).padStart(2,'0')}E${String(media.episode || 1).padStart(2,'0')}`;
    sendLog(`Ripping ${label} from disc ${discIndex}...`, 'info');
    if (mainWindow) mainWindow.webContents.send('rip-started');
    const outputFile = await makemkvService.ripTitle({
      makemkvcon, discIndex, discTarget, titleId, outputDir: tmpDir,
      onProgress: p => { if (mainWindow) mainWindow.webContents.send('rip-progress', Math.round(p * 100)); },
      onLog: m => sendLog(m, 'info'),
    });
    sendLog(`Rip complete: ${path.basename(outputFile)}`, 'success');
    if (mainWindow) mainWindow.webContents.send('rip-complete', { filePath: outputFile, tmpDir, media: media || null, auto: !!auto });
  } catch (err) {
    sendLog(`Rip failed: ${err.message}`, 'error');
    if (mainWindow) mainWindow.webContents.send('rip-failed', { error: err.message });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// computeOutput / sanitize / uniqueName live in @mkv-tools/core/src/outputNaming
function logPlan(plan) {
  const kept = plan.filter(p => p.keep);
  sendLog(`Keeping ${kept.length} track(s): ` + kept.map(p => `${p.role}/${p.lang}${p.newName ? ` "${p.newName}"` : ''}`).join(', '), 'info');
}
function sendLog(message, level = 'info') { if (mainWindow) mainWindow.webContents.send('log', { message, level, time: new Date().toLocaleTimeString() }); }
function sendProgress(key, percent) { if (mainWindow) mainWindow.webContents.send('progress', { key, percent }); }
function sendItemDone(filePath, ok) { if (mainWindow) mainWindow.webContents.send('item-done', { filePath, ok }); }
