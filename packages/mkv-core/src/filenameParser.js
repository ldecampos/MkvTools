const path = require('path');

const JUNK = /\b(1080p|720p|2160p|4k|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|hdrip|x264|x265|h264|h265|hevc|remux|proper|repack|extended|unrated|directors?.cut)\b/gi;

/**
 * Guess movie OR TV episode info from a filename.
 * Returns { type: 'movie'|'series', ... }
 */
function guessFromFilename(filePath) {
  const raw = path.basename(filePath, path.extname(filePath));
  const normalized = raw.replace(/[._]+/g, ' ');

  // ── Try series patterns first ──
  const se = detectSeasonEpisode(normalized);
  if (se) {
    let seriesTitle = normalized.slice(0, se.index)
      .replace(JUNK, '')
      .replace(/[-–]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (seriesTitle && seriesTitle === seriesTitle.toLowerCase()) {
      seriesTitle = titleCase(seriesTitle);
    }
    return {
      type: 'series',
      title: seriesTitle || '',
      season: se.season,
      episode: se.episode,
      year: ''
    };
  }

  // ── Movie ──
  let work = normalized;
  let year = '';
  const parenYear = work.match(/\((19|20)\d{2}\)/);
  if (parenYear) { year = parenYear[0].replace(/[()]/g, ''); work = work.slice(0, parenYear.index); }
  else {
    const bareYear = work.match(/\b(19|20)\d{2}\b/);
    if (bareYear) { year = bareYear[0]; work = work.slice(0, bareYear.index); }
  }
  let title = work
    .replace(JUNK, '')
    .replace(/\bt\d{2,}\b/gi, '')
    .replace(/\b(cd|disc|disk|part)\s*\d+\b/gi, '')
    .replace(/[-–]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (title && title === title.toLowerCase()) title = titleCase(title);

  return { type: 'movie', title: title || '', year: year || '' };
}

// Detect SxxExx and similar; returns { season, episode, index } or null
function detectSeasonEpisode(name) {
  let m = name.match(/\bS(\d{1,2})[\s.]?E(\d{1,3})(?:[-\s.]?E?\d{1,3})?\b/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]), index: m.index };
  m = name.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]), index: m.index };
  m = name.match(/\bSeason[\s.]?(\d{1,2})[\s.]+Episode[\s.]?(\d{1,3})\b/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]), index: m.index };
  return null;
}

function titleCase(s) { return s.replace(/\b\w/g, c => c.toUpperCase()); }

module.exports = { guessFromFilename };
