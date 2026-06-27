'use strict';
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

/**
 * Download a TMDB poster to a temp file and return its path.
 * Returns null if posterPath is missing, download fails, or the response is not an image.
 * Caller is responsible for deleting the temp file after use.
 */
function downloadPoster(posterPath) {
  if (!posterPath) return Promise.resolve(null);

  // posterPath may arrive as a full URL (from tmdbService) or as a raw TMDB path (/abc.jpg).
  // When it's already a URL, upgrade from the thumbnail size to w500 for embedding quality.
  const url = posterPath.startsWith('http')
    ? posterPath.replace(/\/p\/w\d+\//, '/p/w500/')
    : `${TMDB_IMAGE_BASE}${posterPath}`;

  const rawPath = posterPath.startsWith('http') ? new URL(posterPath).pathname : posterPath;
  const ext  = path.extname(rawPath) || '.jpg';
  const dest = path.join(os.tmpdir(), `mkv-cover-${Date.now()}${ext}`);

  return new Promise(resolve => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      const ct = res.headers['content-type'] || '';
      if (res.statusCode !== 200 || !ct.startsWith('image/')) {
        res.resume();
        file.destroy();
        fs.unlink(dest, () => {});
        return resolve(null);
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', () => { fs.unlink(dest, () => {}); resolve(null); });
    }).on('error', () => { fs.unlink(dest, () => {}); resolve(null); });
  });
}

module.exports = { downloadPoster };
