'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createStore } = require('@mkv-tools/core/src/store');
const { remuxService } = require('./remuxService');
const { tmdbService } = require('@mkv-tools/core/src/tmdbService');
const { jellyfinService } = require('@mkv-tools/core/src/jellyfinService');
const { guessFromFilename } = require('@mkv-tools/core/src/filenameParser');
const { FILE_VARIABLES, AUDIO_VARIABLES, SUBTITLE_VARIABLES, SERIES_VARIABLES, TRACK_VARIABLES, BUILTIN_PRESETS, renderTemplate, buildMediaCtx } = require('@mkv-tools/core/src/nameTemplate');
const { ALL_LANGS, VARIANT_MAP, variantsForLang } = require('@mkv-tools/core/src/langData');
const { getStrings, languageList, SUPPORTED } = require('./i18n');
const mkvmergeSetup = require('@mkv-tools/core/src/mkvmergeSetup');
const makemkvService = require('./makemkvService');

const ocrService = require('@mkv-tools/core/src/ocrService');
// Settings file shared with Merger; migrates automatically from the old name on first run
const store = createStore('.mkv-tools-settings.json', '.mkv-remuxer-settings.json');

function detectOSLang() {
  try {
    const locale = (app.getLocale() || 'en').toLowerCase();
    const base = locale.split('-')[0];
    return SUPPORTED.includes(base) ? base : 'en';
  } catch (_) { return 'en'; }
}

const DEFAULTS = {
  outputPath: path.join(os.homedir(), 'Movies'),
  audioLangs: 'spa, eng',
  subLangs: 'spa, eng',
  audioCodecs: '',
  audioNameTemplate: '{lang} {variant_label} {codec_short} {channels}',
  subNameTemplate: '{lang} {variant_label} {forced}',
  fileTitleTemplate: '{title_year}',
  outputNameTemplate: '{title_year}',
  createFolder: true,
  folderNameTemplate: '{title_year}',
  customFileTitle: false,
  seriesOutputNameTemplate: '{series} - {sxxexx} - {episode_title}',
  seriesFileTitleTemplate: '',
  seriesCustomFileTitle: false,
  seriesCreateFolders: true,
  seriesShowFolderTemplate: '{series} ({year})',
  seriesSeasonFolderTemplate: 'Season {season2}',
  fetchEpisodeTitle: true,
  oneSubPerLang: false,
  oneAudioPerLang: false,
  includeNormalSubs: true,
  includeForcedSubs: true,
  includeSdh: false,
  includeSigns: false,
  includeUnknownSubs: true,
  ocrEnabled: false,
  ocrPath: '',
  writeImdbTag: true,
  embedCoverArt: false,
  imdbInFolder: false,
  onFileExists: 'rename',
  tmdbApiKey: '',
  ripTempPath: '',
  jellyfinEnabled: false,
  jellyfinUrl: '',
  jellyfinApiKey: '',
  uiLang: '',
  userPresets: {}
};

let mainWindow;
let processing = false;
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
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = store.get(k, DEFAULTS[k]);
  if (!s.uiLang) s.uiLang = detectOSLang();
  return s;
}
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (_, settings) => {
  Object.entries(settings).forEach(([k, v]) => store.set(k, v));
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
  blockSleep();
  runBatch(items).finally(() => { processing = false; unblockSleep(); });
  return { started: true };
});
ipcMain.handle('cancel', () => { remuxService.cancel(); processing = false; unblockSleep(); return true; });

async function runBatch(items) {
  const settings = getSettings();
  let done = 0;
  const plannedOutputs = new Set();

  for (const item of items) {
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

      await remuxService.produce({
        input: filePath, output, plan, fileTitle,
        movie, writeImdbTag: settings.writeImdbTag, embedCoverArt: settings.embedCoverArt,
        onProgress: p => sendProgress(filePath, Math.round(p * 100)),
        onLog: m => sendLog(m, 'info')
      });

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
function buildFileCtx(movie, filePath, plan) {
  const filename = path.basename(filePath, path.extname(filePath));
  const title = movie?.title || filename;
  const year = movie?.year || '';
  return {
    title, year,
    title_year: year ? `${title} (${year})` : title,
    filename,
    ...buildMediaCtx(plan, filePath, title),
  };
}
function buildSeriesCtx(movie, filePath, plan) {
  const filename = path.basename(filePath, path.extname(filePath));
  const season = movie?.season || 0;
  const episode = movie?.episode || 0;
  const pad = n => String(n).padStart(2, '0');
  const title = movie?.title || filename;
  return {
    series: title, year: movie?.year || '',
    season: String(season), episode: String(episode),
    season2: pad(season), episode2: pad(episode),
    sxxexx: `S${pad(season)}E${pad(episode)}`,
    episode_title: movie?.episodeTitle || '', filename,
    ...buildMediaCtx(plan, filePath, title),
  };
}
function computeOutput(filePath, movie, settings, isSeries, plan) {
  if (isSeries) {
    const ctx = buildSeriesCtx(movie, filePath, plan);
    const outName = render(settings.seriesOutputNameTemplate || '{series} - {sxxexx}', ctx) || ctx.filename;
    let outDir = settings.outputPath;
    if (settings.seriesCreateFolders) {
      let showFolder = render(settings.seriesShowFolderTemplate || '{series} ({year})', ctx) || ctx.series;
      if (settings.imdbInFolder && movie && movie.imdbId) showFolder = `${showFolder} [imdbid-${movie.imdbId}]`;
      const seasonFolder = render(settings.seriesSeasonFolderTemplate || 'Season {season2}', ctx) || `Season ${ctx.season2}`;
      outDir = path.join(settings.outputPath, sanitize(showFolder), sanitize(seasonFolder));
    }
    const fileTitle = settings.seriesCustomFileTitle ? render(settings.seriesFileTitleTemplate || '', ctx) : outName;
    return { output: path.join(outDir, sanitize(outName) + '.mkv'), fileTitle };
  }
  const ctx = buildFileCtx(movie, filePath, plan);
  const outName = render(settings.outputNameTemplate || '{title_year}', ctx) || ctx.filename;
  let outDir = settings.outputPath;
  if (settings.createFolder) {
    let folder = render(settings.folderNameTemplate || '{title_year}', ctx) || ctx.title_year;
    if (settings.imdbInFolder && movie && movie.imdbId) folder = `${folder} [imdbid-${movie.imdbId}]`;
    outDir = path.join(settings.outputPath, sanitize(folder));
  }
  const fileTitle = settings.customFileTitle ? render(settings.fileTitleTemplate || '', ctx) : outName;
  return { output: path.join(outDir, sanitize(outName) + '.mkv'), fileTitle };
}
function render(tpl, ctx) { return renderTemplate(tpl, ctx); }
function sanitize(name) { return (name || 'output').replace(/[\/\\:*?"<>|]/g, '').trim() || 'output'; }
function uniqueName(fullPath, plannedSet) {
  if (!fs.existsSync(fullPath) && !plannedSet.has(fullPath)) return fullPath;
  const dir = path.dirname(fullPath);
  const ext = path.extname(fullPath);
  const base = path.basename(fullPath, ext);
  let n = 1, candidate;
  do { candidate = path.join(dir, `${base} (${n})${ext}`); n++; }
  while ((fs.existsSync(candidate) || plannedSet.has(candidate)) && n < 1000);
  return candidate;
}
function logPlan(plan) {
  const kept = plan.filter(p => p.keep);
  sendLog(`Keeping ${kept.length} track(s): ` + kept.map(p => `${p.role}/${p.lang}${p.newName ? ` "${p.newName}"` : ''}`).join(', '), 'info');
}
function sendLog(message, level = 'info') { if (mainWindow) mainWindow.webContents.send('log', { message, level, time: new Date().toLocaleTimeString() }); }
function sendProgress(key, percent) { if (mainWindow) mainWindow.webContents.send('progress', { key, percent }); }
function sendItemDone(filePath, ok) { if (mainWindow) mainWindow.webContents.send('item-done', { filePath, ok }); }
