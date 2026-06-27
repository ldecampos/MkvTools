'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const os  = require('os');
const fs  = require('fs');

// Shared settings with Remuxer (same file → configure once, applies to both apps)
const { createStore }      = require('@mkv-tools/core/src/store');
const { identifyTracks }   = require('@mkv-tools/core/src/mkvmergeService');
const { tmdbService }      = require('@mkv-tools/core/src/tmdbService');
const { jellyfinService }  = require('@mkv-tools/core/src/jellyfinService');
const { guessFromFilename } = require('@mkv-tools/core/src/filenameParser');
const {
  FILE_VARIABLES, AUDIO_VARIABLES, SUBTITLE_VARIABLES,
  SERIES_VARIABLES, TRACK_VARIABLES, BUILTIN_PRESETS,
  renderTemplate, buildMediaCtx,
} = require('@mkv-tools/core/src/nameTemplate');
const { ALL_LANGS, VARIANT_MAP } = require('@mkv-tools/core/src/langData');
const mkvmergeSetup = require('@mkv-tools/core/src/mkvmergeSetup');
const ffmpegSetup   = require('@mkv-tools/core/src/ffmpegSetup');
const { getStrings, languageList } = require('./i18n');
const { analyzeSyncSources } = require('@mkv-tools/core/src/syncService');
const { planMergeTracks }    = require('./planMerge');
const { produce, cancel }    = require('./mergeService');
const ocrService             = require('@mkv-tools/core/src/ocrService');

// Settings file shared with Remuxer; migrates automatically from the old name on first run
const store = createStore('.mkv-tools-settings.json', '.mkv-remuxer-settings.json');

const DEFAULTS = {
  uiLang:                    '',
  outputPath:                path.join(os.homedir(), 'Movies'),
  audioLangs:                'spa, eng',
  subLangs:                  'spa, eng',
  audioCodecs:               '',
  audioNameTemplate:         '{lang} {variant_label} {codec_short} {channels}',
  subNameTemplate:           '{lang} {variant_label} {forced}',
  fileTitleTemplate:         '{title_year}',
  outputNameTemplate:        '{title_year}',
  createFolder:              true,
  folderNameTemplate:        '{title_year}',
  customFileTitle:           false,
  seriesOutputNameTemplate:  '{series} - {sxxexx} - {episode_title}',
  seriesFileTitleTemplate:   '',
  seriesCustomFileTitle:     false,
  seriesCreateFolders:       true,
  seriesShowFolderTemplate:  '{series} ({year})',
  seriesSeasonFolderTemplate:'Season {season2}',
  fetchEpisodeTitle:         true,
  oneSubPerLang:             false,
  oneAudioPerLang:           false,
  includeNormalSubs:         true,
  includeForcedSubs:         true,
  includeSdh:                false,
  includeSigns:              false,
  includeCommentary:         false,
  includeAccessibility:      false,
  includeUnknownSubs:        true,
  ocrEnabled:                false,
  ocrPath:                   '',
  writeImdbTag:              true,
  embedCoverArt:             false,
  imdbInFolder:              false,
  onFileExists:              'rename',
  tmdbApiKey:                '',
  jellyfinEnabled:           false,
  jellyfinUrl:               '',
  jellyfinApiKey:            '',
};

let mainWindow;
let merging = false;
let sleepBlockerId = null;

function blockSleep()   { if (sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension'); }
function unblockSleep() {
  if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId);
  sleepBlockerId = null;
}

function getSettings() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) s[k] = store.get(k, DEFAULTS[k]);
  return s;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 800, minWidth: 860, minHeight: 640,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f0f1a',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  const toolsDir = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  mkvmergeSetup.setToolsDir(toolsDir);
  ffmpegSetup.setToolsDir(toolsDir);
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Settings ───────────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (_, s) => { Object.entries(s).forEach(([k, v]) => store.set(k, v)); return true; });
ipcMain.handle('get-meta', () => ({
  fileVariables: FILE_VARIABLES, trackVariables: TRACK_VARIABLES,
  audioVariables: AUDIO_VARIABLES, subtitleVariables: SUBTITLE_VARIABLES,
  seriesVariables: SERIES_VARIABLES, builtinPresets: BUILTIN_PRESETS,
  allLangs: ALL_LANGS, variantMap: VARIANT_MAP,
  uiLanguages: languageList(),
}));
ipcMain.handle('get-strings', (_, lang) => getStrings(lang));

// ── Tools status ───────────────────────────────────────────────────────────────
ipcMain.handle('get-tools-status', () => ({
  mkvmerge: mkvmergeSetup.getStatus(),
  ffmpeg:   ffmpegSetup.getStatus(),
}));
ipcMain.handle('get-ocr-status', async () => {
  const settings = getSettings();
  return ocrService.getStatus(settings.ocrPath || '');
});
ipcMain.handle('ocr-convert', async (_, { filePath, trackId, lang }) => {
  const settings = getSettings();
  if (!settings.ocrEnabled) return { ok: false, error: 'OCR is disabled in settings' };
  const mkvmergePath = mkvmergeSetup.findMkvmerge();
  try {
    mainWindow?.webContents.send('ocr-progress', { trackId, progress: 0 });
    const srt = await ocrService.convertPgsToSrt(filePath, trackId, {
      mkvmergePath,
      lang,
      customTesseractPath: settings.ocrPath || '',
    }, frac => {
      mainWindow?.webContents.send('ocr-progress', { trackId, progress: Math.round((frac || 0) * 100) });
    });
    return { ok: true, srt };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('open-url', (_, url) => {
  const safe = [
    'https://mkvtoolnix.download', 'https://ffmpeg.org',
    'https://www.themoviedb.org', 'https://github.com/UB-Mannheim/tesseract',
  ];
  if (safe.some(s => url.startsWith(s))) shell.openExternal(url);
});

// ── File pickers ───────────────────────────────────────────────────────────────
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: store.get('outputPath', DEFAULTS.outputPath),
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('choose-sources', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'ts', 'm2ts', 'mov'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

// ── Identify a single source ───────────────────────────────────────────────────
ipcMain.handle('identify-source', async (_, file) => {
  try {
    const { tracks, title } = await identifyTracks(file, msg => log(msg));
    return { ok: true, tracks, title, file };
  } catch (err) {
    return { ok: false, error: err.message, file };
  }
});

// ── Analyze movie/series from primary filename + TMDB ─────────────────────────
ipcMain.handle('analyze-movie', async (_, filePath) => {
  const settings = getSettings();
  const guess = guessFromFilename(filePath);
  let movie = null;
  let candidates = [];

  try {
    if (guess.type === 'series' && guess.title) {
      candidates = await tmdbService.searchTV(guess.title, settings.tmdbApiKey);
      movie = candidates[0] || null;
      if (movie) {
        movie.season = guess.season; movie.episode = guess.episode;
        if (movie.id && settings.fetchEpisodeTitle) {
          const ep = await tmdbService.getEpisode(movie.id, guess.season, guess.episode, settings.tmdbApiKey);
          movie.episodeTitle = ep.episodeTitle;
        }
      }
    } else if (guess.title) {
      candidates = await tmdbService.search(guess.title, settings.tmdbApiKey);
      movie = (guess.year ? candidates.find(c => c.year === guess.year) : null) || candidates[0] || null;
    }
    if (!movie && (guess.title || guess.year)) {
      movie = { id: null, type: guess.type, title: guess.title || '', year: guess.year || '', imdbId: null, posterPath: null };
    }
  } catch (e) {
    log(`TMDB: ${e.message}`, 'warn');
  }

  return { guess, movie: movie || null, candidates };
});

ipcMain.handle('search-movie', async (_, arg) => {
  const key = store.get('tmdbApiKey', '');
  if (!key) return { noKey: true, results: [] };
  const q = typeof arg === 'string' ? arg : arg.query;
  const yr = typeof arg === 'object' ? arg.year : undefined;
  try { return await tmdbService.search(q, key, yr); } catch { return []; }
});
ipcMain.handle('search-tv', async (_, arg) => {
  const key = store.get('tmdbApiKey', '');
  if (!key) return { noKey: true, results: [] };
  const q = typeof arg === 'string' ? arg : arg.query;
  const yr = typeof arg === 'object' ? arg.year : undefined;
  try { return await tmdbService.searchTV(q, key, yr); } catch { return []; }
});
ipcMain.handle('get-episode', async (_, { tvId, season, episode }) => {
  const key = store.get('tmdbApiKey', '');
  if (!key) return { episodeTitle: '' };
  try { return await tmdbService.getEpisode(tvId, season, episode, key); } catch { return { episodeTitle: '' }; }
});

// ── Plan tracks (with optional overrides) ─────────────────────────────────────
ipcMain.handle('plan-tracks', (_, { sources, overrides, forcedVideoSource }) => {
  const settings = getSettings();
  return planMergeTracks(sources, settings, overrides || {}, forcedVideoSource ?? null);
});

// ── Sync analysis ──────────────────────────────────────────────────────────────
ipcMain.handle('analyze-sync', async (_, sources) => {
  try {
    const results = await analyzeSyncSources(sources, msg => log(msg, 'info'));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Merge ──────────────────────────────────────────────────────────────────────
ipcMain.handle('merge', async (_, { sources, plan, movie, syncResults, videoSourceIndex }) => {
  if (merging) return { ok: false, error: 'Already merging' };
  merging = true; blockSleep();
  try {
    const settings = getSettings();
    const isSeries = movie && movie.type === 'series';
    const { output, fileTitle } = computeOutput(sources[videoSourceIndex].file, movie, settings, isSeries, plan);

    // Resolve file-exists policy
    let finalOutput = output;
    if (fs.existsSync(finalOutput)) {
      if (settings.onFileExists === 'skip') {
        log(`Skipped (already exists): ${path.basename(finalOutput)}`, 'warn');
        mainWindow.webContents.send('merge-complete', { output: finalOutput, skipped: true });
        return { ok: true };
      } else if (settings.onFileExists === 'rename') {
        finalOutput = uniqueName(finalOutput);
        log(`Renamed to avoid overwrite: ${path.basename(finalOutput)}`, 'info');
      }
    }
    fs.mkdirSync(path.dirname(finalOutput), { recursive: true });

    await produce({
      sources, output: finalOutput, plan, fileTitle, movie,
      writeImdbTag: settings.writeImdbTag,
      embedCoverArt: settings.embedCoverArt,
      syncResults: syncResults || [],
      onProgress: p => mainWindow?.webContents.send('progress', Math.round(p * 100)),
      onLog: m => log(m, 'info'),
    });

    log(`Done: ${finalOutput}`, 'success');
    mainWindow?.webContents.send('merge-complete', { output: finalOutput });

    if (settings.jellyfinEnabled) {
      await jellyfinService.refreshLibrary({
        serverUrl: settings.jellyfinUrl,
        apiKey: settings.jellyfinApiKey,
        onLog: m => log(m, 'info'),
      });
    }

    return { ok: true, output: finalOutput };
  } catch (err) {
    log(`Failed: ${err.message}`, 'error');
    mainWindow?.webContents.send('merge-error', err.message);
    return { ok: false, error: err.message };
  } finally {
    merging = false; unblockSleep();
  }
});

ipcMain.handle('cancel', () => { cancel(); merging = false; unblockSleep(); return true; });

// ── Helpers ────────────────────────────────────────────────────────────────────
function buildFileCtx(movie, filePath, plan) {
  const filename = path.basename(filePath, path.extname(filePath));
  const title = movie?.title || filename;
  const year  = movie?.year  || '';
  return {
    title, year,
    title_year: year ? `${title} (${year})` : title,
    filename,
    ...buildMediaCtx(plan, filePath, title),
  };
}
function buildSeriesCtx(movie, filePath, plan) {
  const filename = path.basename(filePath, path.extname(filePath));
  const season = movie?.season  || 0;
  const ep     = movie?.episode || 0;
  const pad    = n => String(n).padStart(2, '0');
  const title  = movie?.title || filename;
  return {
    series: title, year: movie?.year || '',
    season: String(season), episode: String(ep),
    season2: pad(season), episode2: pad(ep),
    sxxexx: `S${pad(season)}E${pad(ep)}`,
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
      if (settings.imdbInFolder && movie?.imdbId) showFolder += ` [imdbid-${movie.imdbId}]`;
      const seasonFolder = render(settings.seriesSeasonFolderTemplate || 'Season {season2}', ctx);
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
    if (settings.imdbInFolder && movie?.imdbId) folder += ` [imdbid-${movie.imdbId}]`;
    outDir = path.join(settings.outputPath, sanitize(folder));
  }
  const fileTitle = settings.customFileTitle ? render(settings.fileTitleTemplate || '', ctx) : outName;
  return { output: path.join(outDir, sanitize(outName) + '.mkv'), fileTitle };
}
function render(tpl, ctx)  { return renderTemplate(tpl, ctx); }
function sanitize(name)    { return (name || 'output').replace(/[/\\:*?"<>|]/g, '').trim() || 'output'; }
function uniqueName(fp) {
  if (!fs.existsSync(fp)) return fp;
  const dir = path.dirname(fp), ext = path.extname(fp), base = path.basename(fp, ext);
  let n = 1, c;
  do { c = path.join(dir, `${base} (${n})${ext}`); n++; } while (fs.existsSync(c) && n < 1000);
  return c;
}
function log(message, level = 'info') {
  mainWindow?.webContents.send('log', { message, level, time: new Date().toLocaleTimeString() });
}
