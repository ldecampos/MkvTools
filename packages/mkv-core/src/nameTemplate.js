const path = require('path');

const _VIDEO_CODEC_SHORT = {
  'V_MPEG4/ISO/AVC':'H.264','V_MPEGH/ISO/HEVC':'H.265',
  'V_AV1':'AV1','V_MPEG2':'MPEG-2',
};
const _AUDIO_CODEC_SHORT = {
  'A_DTS/MA':'DTS-HD MA','A_DTS':'DTS','A_EAC3':'E-AC3','A_AC3':'AC-3',
  'A_TRUEHD':'TrueHD','A_FLAC':'FLAC','A_AAC':'AAC','A_OPUS':'Opus',
};
const _SOURCE_PATTERNS = [
  [/\bremux\b/i,'BluRay REMUX'],[/\bblu-?ray\b/i,'BluRay'],
  [/\bweb-?dl\b/i,'WEB-DL'],[/\bweb-?rip\b/i,'WEBRip'],
  [/\bhdtv\b/i,'HDTV'],[/\bdvdrip\b/i,'DVDRip'],
];

function _pixelsToRes(dim) {
  if (!dim) return '';
  const [w, h] = dim.split('x').map(Number);
  if (!h) return '';
  if (h >= 2160 || w >= 3840) return '2160p';
  if (h >= 1080 || w >= 1920) return '1080p';
  if (h >= 720  || w >= 1280) return '720p';
  if (h >= 480  || w >= 854)  return '480p';
  return `${h}p`;
}

function _hdrType(transfer, primaries) {
  if (transfer === 16 && primaries === 9) return 'HDR10';
  if (transfer === 16) return 'HDR';
  if (transfer === 18) return 'HLG';
  return '';
}

function _fmtCh(n) {
  if (n === 8) return '7.1';
  if (n === 6) return '5.1';
  if (n === 2) return '2.0';
  if (n === 1) return '1.0';
  return n ? `${n}ch` : '';
}

function _cleanTitle(title) {
  return (title || '').replace(/['"`:!?]/g, '').replace(/\s+/g, ' ').trim();
}

function _releaseGroup(filename) {
  let m = /-([A-Za-z0-9]{2,12})(?:\.[a-z]{1,4})?$/.exec(filename);
  if (m) return m[1];
  m = /\[([A-Za-z0-9]{2,12})\](?:\.[a-z]{1,4})?$/.exec(filename);
  return m ? m[1] : '';
}

function _source(filename) {
  for (const [re, label] of _SOURCE_PATTERNS) {
    if (re.test(filename)) return label;
  }
  return '';
}

function buildMediaCtx(plan, filePath, title) {
  const filename = path.basename(filePath || '', path.extname(filePath || ''));
  const keptVideo  = (plan || []).find(p => p.role === 'video' && p.keep);
  const keptAudios = (plan || []).filter(p => p.role === 'audio' && p.keep);
  const bestAudio  = keptAudios.sort((a, b) => (b.channels || 0) - (a.channels || 0))[0];
  return {
    resolution:     _pixelsToRes(keptVideo?.pixelDimensions),
    video_codec:    _VIDEO_CODEC_SHORT[keptVideo?.codec] || '',
    hdr:            _hdrType(keptVideo?.colorTransfer, keptVideo?.colorPrimaries),
    audio_codec:    _AUDIO_CODEC_SHORT[bestAudio?.codec] || '',
    audio_channels: _fmtCh(bestAudio?.channels),
    release_group:  _releaseGroup(filename),
    source:         _source(filename),
    clean_title:    _cleanTitle(title || ''),
  };
}

/**
 * Render a template by replacing {variable} placeholders, then clean up
 * separators left around variables that resolved to empty strings.
 */
function renderTemplate(template, ctx) {
  if (!template) return '';
  let out = template.replace(/\{rg_([^}]+)\}/g, (_, name) => name);
  out = out.replace(/\{(\w+)\}/g, (m, key) =>
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
  { token: '{title}',          desc: 'Movie title (The Matrix)' },
  { token: '{clean_title}',    desc: 'Title without special characters (The Matrix)' },
  { token: '{year}',           desc: 'Release year (1999)' },
  { token: '{title_year}',     desc: 'Title with year (The Matrix (1999))' },
  { token: '{filename}',       desc: 'Original filename without extension' },
  { token: '{resolution}',     desc: 'Video resolution (1080p, 2160p, 720p)' },
  { token: '{video_codec}',    desc: 'Video codec (H.264, H.265, AV1)' },
  { token: '{hdr}',            desc: 'HDR type (HDR10, HLG) — empty for SDR' },
  { token: '{audio_codec}',    desc: 'Best audio codec (DTS-HD MA, TrueHD, E-AC3)' },
  { token: '{audio_channels}', desc: 'Best audio channels (5.1, 7.1, 2.0)' },
  { token: '{release_group}',  desc: 'Release group from filename (EVOLVE, PiR8)' },
  { token: '{source}',         desc: 'Release source (BluRay, WEB-DL, HDTV)' },
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
  { token: '{series}',         desc: 'Series name (Breaking Bad)' },
  { token: '{year}',           desc: 'Series first-air year (2008)' },
  { token: '{season}',         desc: 'Season number (1)' },
  { token: '{episode}',        desc: 'Episode number (5)' },
  { token: '{season2}',        desc: 'Season, 2 digits (01)' },
  { token: '{episode2}',       desc: 'Episode, 2 digits (05)' },
  { token: '{sxxexx}',         desc: 'Combined code (S01E05)' },
  { token: '{episode_title}',  desc: 'Episode title (Gray Matter)' },
  { token: '{filename}',       desc: 'Original filename without extension' },
  { token: '{resolution}',     desc: 'Video resolution (1080p, 2160p, 720p)' },
  { token: '{video_codec}',    desc: 'Video codec (H.264, H.265, AV1)' },
  { token: '{hdr}',            desc: 'HDR type (HDR10, HLG) — empty for SDR' },
  { token: '{audio_codec}',    desc: 'Best audio codec (DTS-HD MA, TrueHD, E-AC3)' },
  { token: '{audio_channels}', desc: 'Best audio channels (5.1, 7.1, 2.0)' },
  { token: '{release_group}',  desc: 'Release group from filename (EVOLVE, PiR8)' },
  { token: '{source}',         desc: 'Release source (BluRay, WEB-DL, HDTV)' },
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
    { label: 'Title (Year)',                    value: '{title_year}' },
    { label: 'Title (Year) Quality',            value: '{title_year} {resolution} {video_codec}' },
    { label: 'Title (Year) Quality HDR Group',  value: '{title_year} {resolution} {hdr} {video_codec}-{release_group}' },
    { label: 'Title only',                      value: '{title}' },
    { label: 'Keep original',                   value: '{filename}' }
  ],
  folderName: [
    { label: 'Title (Year)',         value: '{title_year}' },
    { label: 'Title only',          value: '{title}' }
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
    { label: 'Series - SxxExx - Episode',                    value: '{series} - {sxxexx} - {episode_title}' },
    { label: 'Series - SxxExx - Episode Quality',            value: '{series} - {sxxexx} - {episode_title} {resolution} {video_codec}' },
    { label: 'Series - SxxExx - Episode Quality HDR Group',  value: '{series} - {sxxexx} - {episode_title} {resolution} {hdr} {video_codec}-{release_group}' },
    { label: 'Series - SxxExx',     value: '{series} - {sxxexx}' },
    { label: 'SxxExx - Episode',    value: '{sxxexx} - {episode_title}' },
    { label: 'Keep original',       value: '{filename}' }
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

module.exports = { renderTemplate, buildMediaCtx, FILE_VARIABLES, AUDIO_VARIABLES, SUBTITLE_VARIABLES, SERIES_VARIABLES, TRACK_VARIABLES, BUILTIN_PRESETS };
