const https = require('https');

const BASE_HOST = 'api.themoviedb.org';

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: BASE_HOST, path, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON from TMDb')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TMDb request timed out')); });
  });
}

const tmdbService = {
  // Movie search
  async search(query, apiKey, year) {
    const q = encodeURIComponent(cleanName(query));
    const y = year ? `&year=${year}` : '';
    const res = await getJson(`/3/search/movie?api_key=${apiKey}&query=${q}&language=en-US&include_adult=false${y}`);
    const top = (res.results || []).slice(0, 6);
    return Promise.all(top.map(async (m) => {
      let imdbId = null;
      try {
        const d = await getJson(`/3/movie/${m.id}?api_key=${apiKey}`);
        imdbId = d.imdb_id || null;
      } catch (_) {}
      return {
        id: m.id, type: 'movie',
        title: m.title, originalTitle: m.original_title,
        year: m.release_date ? m.release_date.substring(0, 4) : '????',
        overview: m.overview,
        posterPath: m.poster_path ? `https://image.tmdb.org/t/p/w92${m.poster_path}` : null,
        imdbId
      };
    }));
  },

  // TV series search
  async searchTV(query, apiKey, year) {
    const q = encodeURIComponent(cleanName(query));
    const y = year ? `&first_air_date_year=${year}` : '';
    const res = await getJson(`/3/search/tv?api_key=${apiKey}&query=${q}&language=en-US&include_adult=false${y}`);
    const top = (res.results || []).slice(0, 6);
    return Promise.all(top.map(async (s) => {
      let imdbId = null;
      try {
        const ext = await getJson(`/3/tv/${s.id}/external_ids?api_key=${apiKey}`);
        imdbId = ext.imdb_id || null;
      } catch (_) {}
      return {
        id: s.id, type: 'series',
        title: s.name, originalTitle: s.original_name,
        year: s.first_air_date ? s.first_air_date.substring(0, 4) : '????',
        overview: s.overview,
        posterPath: s.poster_path ? `https://image.tmdb.org/t/p/w92${s.poster_path}` : null,
        imdbId
      };
    }));
  },

  // Get a specific episode's name and ids
  async getEpisode(tvId, season, episode, apiKey) {
    try {
      const ep = await getJson(`/3/tv/${tvId}/season/${season}/episode/${episode}?api_key=${apiKey}&language=en-US`);
      let imdbId = null;
      try {
        const ext = await getJson(`/3/tv/${tvId}/season/${season}/episode/${episode}/external_ids?api_key=${apiKey}`);
        imdbId = ext.imdb_id || null;
      } catch (_) {}
      return {
        episodeTitle: ep.name || '',
        airDate: ep.air_date || '',
        overview: ep.overview || '',
        episodeImdbId: imdbId
      };
    } catch (_) {
      return { episodeTitle: '', airDate: '', overview: '', episodeImdbId: null };
    }
  }
};

function cleanName(n) {
  return n.replace(/_/g, ' ').replace(/\bBD\b|\bBDROM\b|\bBLURAY\b|\bBLU.RAY\b/gi, '')
    .replace(/\b(disc|disk)\s*\d+\b/gi, '').replace(/\(\d{4}\)/g, '')
    .replace(/[_\-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

module.exports = { tmdbService };
