'use strict';
const path = require('path');
const os = require('os');

/**
 * Single source of truth for the settings schema shared by both apps.
 *
 * Both MKV Remuxer and MKV Merger persist to the same settings file, so their
 * defaults MUST stay in sync — otherwise a key one app writes is invisible to
 * the other (and even to itself, since getAll() only reads known keys).
 * Keeping the schema here prevents that drift.
 */
const BASE_DEFAULTS = {
  uiLang: '',
  outputPath: path.join(os.homedir(), 'Movies'),

  // Track filtering
  audioLangs: 'spa, eng',
  subLangs: 'spa, eng',
  audioCodecs: '',
  oneSubPerLang: false,
  oneAudioPerLang: false,
  includeNormalSubs: true,
  includeForcedSubs: true,
  includeSdh: false,
  includeSigns: false,
  includeCommentary: false,
  includeAccessibility: false,
  includeUnknownSubs: true,

  // Naming templates
  audioNameTemplate: '{lang} {variant_label} {codec_short} {channels}',
  subNameTemplate: '{lang} {variant_label} {forced}',
  fileTitleTemplate: '{title_year}',
  outputNameTemplate: '{title_year}',
  createFolder: true,
  folderNameTemplate: '{title_year}',
  customFileTitle: false,

  // Series naming
  seriesOutputNameTemplate: '{series} - {sxxexx} - {episode_title}',
  seriesFileTitleTemplate: '',
  seriesCustomFileTitle: false,
  seriesCreateFolders: true,
  seriesShowFolderTemplate: '{series} ({year})',
  seriesSeasonFolderTemplate: 'Season {season2}',
  fetchEpisodeTitle: true,

  // OCR
  ocrEnabled: false,
  ocrPath: '',

  // Metadata / tags
  writeImdbTag: true,
  embedCoverArt: false,
  imdbInFolder: false,
  onFileExists: 'rename',
  tmdbApiKey: '',

  // Jellyfin integration
  jellyfinEnabled: false,
  jellyfinUrl: '',
  jellyfinApiKey: '',

  // User-defined naming presets (used by both apps)
  userPresets: {},
};

/**
 * Build a settings accessor backed by a store, with optional app-specific
 * defaults layered on top of the shared base schema.
 *
 * @param {{ get: Function, set: Function }} store
 * @param {object} [appDefaults] extra keys only this app uses (e.g. ripTempPath)
 * @returns {{ DEFAULTS: object, getAll: () => object, saveAll: (partial: object) => void }}
 */
function createSettings(store, appDefaults = {}) {
  const DEFAULTS = { ...BASE_DEFAULTS, ...appDefaults };

  function getAll() {
    const s = {};
    for (const k of Object.keys(DEFAULTS)) s[k] = store.get(k, DEFAULTS[k]);
    return s;
  }

  function saveAll(partial) {
    for (const [k, v] of Object.entries(partial)) store.set(k, v);
  }

  return { DEFAULTS, getAll, saveAll };
}

module.exports = { BASE_DEFAULTS, createSettings };
