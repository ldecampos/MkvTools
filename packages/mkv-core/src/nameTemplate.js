/**
 * Render a template by replacing {variable} placeholders, then clean up
 * separators left around variables that resolved to empty strings.
 */
function renderTemplate(template, ctx) {
  if (!template) return '';
  let out = template.replace(/\{(\w+)\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(ctx, key) ? (ctx[key] ?? '') : m
  );
  out = out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([-–·,|])\s*$/g, '')
    .replace(/^\s*([-–·,|])\s+/g, '')
    .replace(/([-–·,|])\s*\1/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .trim();
  return out;
}

// Variables that apply to the whole file (file title, output filename, folder)
const FILE_VARIABLES = [
  { token: '{title}',      desc: 'Movie title (The Matrix)' },
  { token: '{year}',       desc: 'Release year (1999)' },
  { token: '{title_year}', desc: 'Title with year (The Matrix (1999))' },
  { token: '{filename}',   desc: 'Original filename without extension' }
];

// Variables that apply to an individual audio/subtitle track
// Variables for AUDIO tracks (no forced/default — not meaningful for audio here)
const AUDIO_VARIABLES = [
  { token: '{lang}',          desc: 'Language, native name (Español)' },
  { token: '{iso2}',          desc: '2-letter code (es)' },
  { token: '{iso3}',          desc: '3-letter code (spa)' },
  { token: '{ISO2}',          desc: '2-letter uppercase (ES)' },
  { token: '{ISO3}',          desc: '3-letter uppercase (SPA)' },
  { token: '{codec}',         desc: 'Codec, full (DTS-HD Master Audio)' },
  { token: '{codec_short}',   desc: 'Codec, short (DTS-HD MA)' },
  { token: '{channels}',      desc: 'Channel layout (5.1, 2.0)' },
  { token: '{variant}',       desc: 'Regional variant code (ES, LA, BR) — empty if unknown' },
  { token: '{variant_label}', desc: 'Regional variant label (Castilian, Latin American) — empty if unknown' }
];

// Variables for SUBTITLE tracks (forced applies; no default)
const SUBTITLE_VARIABLES = [
  { token: '{lang}',          desc: 'Language, native name (Español)' },
  { token: '{iso2}',          desc: '2-letter code (es)' },
  { token: '{iso3}',          desc: '3-letter code (spa)' },
  { token: '{ISO2}',          desc: '2-letter uppercase (ES)' },
  { token: '{ISO3}',          desc: '3-letter uppercase (SPA)' },
  { token: '{forced}',        desc: '"Forced" if forced track' },
  { token: '{variant}',       desc: 'Regional variant code (ES, LA, BR) — empty if unknown' },
  { token: '{variant_label}', desc: 'Regional variant label (Castilian, Latin American) — empty if unknown' }
];

// Variables for SERIES file-level fields (episode filename, folders, file title)
const SERIES_VARIABLES = [
  { token: '{series}',        desc: 'Series name (Breaking Bad)' },
  { token: '{year}',          desc: 'Series first-air year (2008)' },
  { token: '{season}',        desc: 'Season number (1)' },
  { token: '{episode}',       desc: 'Episode number (5)' },
  { token: '{season2}',       desc: 'Season, 2 digits (01)' },
  { token: '{episode2}',      desc: 'Episode, 2 digits (05)' },
  { token: '{sxxexx}',        desc: 'Combined code (S01E05)' },
  { token: '{episode_title}', desc: 'Episode title (Gray Matter)' },
  { token: '{filename}',      desc: 'Original filename without extension' }
];

// Kept for backward-compat (file fields don't use these)
const TRACK_VARIABLES = AUDIO_VARIABLES;

// Built-in presets per field. Users can add their own (stored in settings).
const BUILTIN_PRESETS = {
  fileTitle: [
    { label: 'Empty', value: '' },
    { label: 'Title (Year)', value: '{title_year}' },
    { label: 'Title only', value: '{title}' }
  ],
  outputName: [
    { label: 'Title (Year)', value: '{title_year}' },
    { label: 'Title only', value: '{title}' },
    { label: 'Keep original', value: '{filename}' }
  ],
  folderName: [
    { label: 'Title (Year)', value: '{title_year}' },
    { label: 'Title only', value: '{title}' }
  ],
  audioName: [
    { label: 'Empty', value: '' },
    { label: 'Language', value: '{lang}' },
    { label: 'Language + variant', value: '{lang} {variant_label}' },
    { label: 'Language + codec', value: '{lang} {codec_short}' },
    { label: 'Language + variant + codec + ch', value: '{lang} {variant_label} {codec_short} {channels}' },
    { label: 'Language + codec + ch', value: '{lang} {codec_short} {channels}' },
    { label: 'English - codec ch', value: '{lang_en} - {codec_short} {channels}' }
  ],
  subName: [
    { label: 'Empty', value: '' },
    { label: 'Language', value: '{lang}' },
    { label: 'Language + variant', value: '{lang} {variant_label}' },
    { label: 'Language + forced', value: '{lang} {forced}' },
    { label: 'English name', value: '{lang_en}' }
  ],
  // ── Series fields (Jellyfin standard by default) ──
  seriesFileTitle: [
    { label: 'Empty', value: '' },
    { label: 'Series - SxxExx - Episode', value: '{series} - {sxxexx} - {episode_title}' },
    { label: 'SxxExx - Episode', value: '{sxxexx} - {episode_title}' }
  ],
  seriesOutputName: [
    { label: 'Series - SxxExx - Episode', value: '{series} - {sxxexx} - {episode_title}' },
    { label: 'Series - SxxExx', value: '{series} - {sxxexx}' },
    { label: 'SxxExx - Episode', value: '{sxxexx} - {episode_title}' },
    { label: 'Keep original', value: '{filename}' }
  ],
  seriesShowFolder: [
    { label: 'Series (Year)', value: '{series} ({year})' },
    { label: 'Series only', value: '{series}' }
  ],
  seriesSeasonFolder: [
    { label: 'Season XX', value: 'Season {season2}' },
    { label: 'Season X', value: 'Season {season}' },
    { label: 'SXX', value: 'S{season2}' }
  ]
};

module.exports = { renderTemplate, FILE_VARIABLES, AUDIO_VARIABLES, SUBTITLE_VARIABLES, SERIES_VARIABLES, TRACK_VARIABLES, BUILTIN_PRESETS };
