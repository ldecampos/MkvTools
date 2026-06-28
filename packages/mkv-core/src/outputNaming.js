'use strict';
const fs = require('fs');
const path = require('path');
const { renderTemplate, buildMediaCtx } = require('./nameTemplate');

/** Strip characters that are illegal in file/folder names. */
function sanitize(name) {
  return (name || 'output').replace(/[/\\:*?"<>|]/g, '').trim() || 'output';
}

/**
 * Return a path that does not collide with an existing file or a path already
 * reserved this run. `plannedSet` is optional (used by batch processing to
 * avoid two queued items resolving to the same name).
 */
function uniqueName(fullPath, plannedSet = null) {
  const taken = p => fs.existsSync(p) || (plannedSet ? plannedSet.has(p) : false);
  if (!taken(fullPath)) return fullPath;
  const dir = path.dirname(fullPath);
  const ext = path.extname(fullPath);
  const base = path.basename(fullPath, ext);
  let n = 1, candidate;
  do { candidate = path.join(dir, `${base} (${n})${ext}`); n++; }
  while (taken(candidate) && n < 1000);
  return candidate;
}

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

/**
 * Compute the output path and embedded file title for a movie or series item.
 * Shared by both apps so naming behaviour stays identical.
 *
 * @returns {{ output: string, fileTitle: string }}
 */
function computeOutput(filePath, movie, settings, isSeries, plan) {
  if (isSeries) {
    const ctx = buildSeriesCtx(movie, filePath, plan);
    const outName = renderTemplate(settings.seriesOutputNameTemplate || '{series} - {sxxexx}', ctx) || ctx.filename;
    let outDir = settings.outputPath;
    if (settings.seriesCreateFolders) {
      let showFolder = renderTemplate(settings.seriesShowFolderTemplate || '{series} ({year})', ctx) || ctx.series;
      if (settings.imdbInFolder && movie && movie.imdbId) showFolder = `${showFolder} [imdbid-${movie.imdbId}]`;
      const seasonFolder = renderTemplate(settings.seriesSeasonFolderTemplate || 'Season {season2}', ctx) || `Season ${ctx.season2}`;
      outDir = path.join(settings.outputPath, sanitize(showFolder), sanitize(seasonFolder));
    }
    const fileTitle = settings.seriesCustomFileTitle ? renderTemplate(settings.seriesFileTitleTemplate || '', ctx) : outName;
    return { output: path.join(outDir, sanitize(outName) + '.mkv'), fileTitle };
  }

  const ctx = buildFileCtx(movie, filePath, plan);
  const outName = renderTemplate(settings.outputNameTemplate || '{title_year}', ctx) || ctx.filename;
  let outDir = settings.outputPath;
  if (settings.createFolder) {
    let folder = renderTemplate(settings.folderNameTemplate || '{title_year}', ctx) || ctx.title_year;
    if (settings.imdbInFolder && movie && movie.imdbId) folder = `${folder} [imdbid-${movie.imdbId}]`;
    outDir = path.join(settings.outputPath, sanitize(folder));
  }
  const fileTitle = settings.customFileTitle ? renderTemplate(settings.fileTitleTemplate || '', ctx) : outName;
  return { output: path.join(outDir, sanitize(outName) + '.mkv'), fileTitle };
}

module.exports = { sanitize, uniqueName, buildFileCtx, buildSeriesCtx, computeOutput };
