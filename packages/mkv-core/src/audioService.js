const { langName, langNameEn, langNameIn, toIso2, toIso3 } = require('./langData');
const { renderTemplate } = require('./nameTemplate');

// Codec quality ranking (higher = better). Lossless > lossy.
function codecRank(codec) {
  const c = (codec || '').toUpperCase();
  if (c.includes('TRUEHD')) return 100;
  if (c.includes('DTS-HD MASTER') || c.includes('DTS-HD MA')) return 95;
  if (c.includes('FLAC') || c.includes('PCM') || c.includes('LPCM')) return 90;
  if (c.includes('DTS-X') || c.includes('DTS:X')) return 85;
  if (c.includes('DTS-HD')) return 80;
  if (c.includes('DTS')) return 60;
  if (c.includes('E-AC-3') || c.includes('EAC3')) return 55;
  if (c.includes('AC-3') || c.includes('AC3')) return 50;
  if (c.includes('AAC')) return 40;
  if (c.includes('MP3') || c.includes('MP2')) return 30;
  return 20;
}

// Quality score: codec first, then channel count.
function qualityScore(track) {
  const ch = parseInt(track.channels) || 0;
  return codecRank(track.codec) * 1000 + ch * 10;
}

function subCodecScore(codec) {
  const c = (codec || '').toUpperCase();
  if (c.includes('SRT') || c.includes('SUBRIP')) return 3;
  if (c.includes('ASS') || c.includes('SSA'))    return 2;
  if (c.includes('PGS') || c.includes('HDMV'))   return 1;
  if (c.includes('VOBSUB') || c.includes('DVDSUB')) return 0;
  return 1;
}

/**
 * Keep only the best-quality track per language among the currently-kept ones.
 * For subtitles, forced tracks compete only among themselves (separate bucket per lang).
 * Special-type subtitle tracks (SDH, Signs…) are grouped per type+lang, not mixed with normal.
 * Marks dropped duplicates with dropReason='duplicate' and the winner with bestOfLang=true.
 */
function dedupeBestPerLang(plan, role, isSubtitle) {
  const groups = {};
  for (const p of plan) {
    if (p.role !== role || !p.keep) continue;
    let key;
    if (p.variant && !p.variant.startsWith('_')) {
      key = p.variant;
    } else if (p.variant && p.variant.startsWith('_')) {
      key = `${p.variant}:${toIso3(p.lang)}`;
    } else {
      key = toIso3(p.lang);
    }
    // Forced tracks compete only among themselves — separate bucket
    if (isSubtitle && p.forced) key = `forced:${key}`;
    (groups[key] = groups[key] || []).push(p);
  }
  for (const key of Object.keys(groups)) {
    const group = groups[key];
    if (group.length <= 1) continue;
    let winner = group[0];
    if (!isSubtitle) {
      for (const g of group) if (qualityScore(g) > qualityScore(winner)) winner = g;
    } else {
      for (const g of group) if (subCodecScore(g.codec) > subCodecScore(winner.codec)) winner = g;
    }
    for (const g of group) {
      if (g === winner) { g.bestOfLang = true; }
      else { g.keep = false; g.dropReason = 'duplicate'; }
    }
  }
}

function parseList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(s => s.trim().toLowerCase()).filter(Boolean);
  return String(v).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function matchesLang(l, wanted, variant) {
  l = (l || '').toLowerCase();
  const i2 = toIso2(l), i3 = toIso3(l);
  for (const w of wanted) {
    const dash = w.indexOf('-');
    if (dash > 0) {
      const wBase = w.slice(0, dash);
      const wRegion = w.slice(dash + 1).toUpperCase();
      const baseMatch = wBase === l || wBase === i2 || wBase === i3;
      if (!baseMatch) continue;
      if (!variant || variant.startsWith('_')) continue;
      const trackRegion = (variant.split('-')[1] || '').toUpperCase();
      if (trackRegion === wRegion) return true;
    } else {
      if (w === l || w === i2 || w === i3) return true;
    }
  }
  return false;
}

function matchesCodec(c, wanted) {
  c = (c || '').toLowerCase();
  return wanted.some(w => c.includes(w.toLowerCase()));
}

function cleanCodec(c) {
  if (!c) return '';
  return c.replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/MPEG-?4.*AVC|AVC\/H\.264.*/i, 'H.264')
    .replace(/HEVC.*/i, 'H.265').trim();
}

function shortCodec(c) {
  const f = cleanCodec(c).toUpperCase();
  if (f.includes('DTS-HD MASTER')) return 'DTS-HD MA';
  if (f.includes('DTS-HD')) return 'DTS-HD';
  if (f.includes('TRUEHD')) return 'TrueHD';
  if (f.includes('E-AC-3') || f.includes('EAC3')) return 'E-AC3';
  if (f.includes('AC-3') || f.includes('AC3')) return 'AC3';
  if (f.includes('DTS')) return 'DTS';
  if (f.includes('AAC')) return 'AAC';
  if (f.includes('PCM') || f.includes('FLAC')) return 'PCM';
  return cleanCodec(c);
}

function chLayout(ch) {
  if (!ch) return '';
  const n = parseInt(ch);
  return ({ 1: '1.0', 2: '2.0', 6: '5.1', 8: '7.1' })[n] || `${n}ch`;
}

function renderName(template, track) {
  if (!template) return '';
  const region = (track.variant && !track.variant.startsWith('_')) ? (track.variant.split('-')[1] || '') : '';
  const ctx = {
    lang: langName(track.lang), lang_en: langNameEn(track.lang),
    iso2: toIso2(track.lang), iso3: toIso3(track.lang),
    ISO2: toIso2(track.lang).toUpperCase(), ISO3: toIso3(track.lang).toUpperCase(),
    codec: cleanCodec(track.codec), codec_short: shortCodec(track.codec),
    channels: chLayout(track.channels),
    forced: track.forced ? 'Forced' : '', default: track.default ? 'Default' : '',
    variant: region,
    variant_label: track.variantLabel || '',
  };
  const resolved = template.replace(/\{lang_([a-z]{2,3})\}/g, (m, dl) => {
    const name = langNameIn(track.lang, dl);
    return name || m;
  });
  return renderTemplate(resolved, ctx);
}

module.exports = {
  codecRank, qualityScore, subCodecScore, dedupeBestPerLang,
  parseList, matchesLang, matchesCodec,
  cleanCodec, shortCodec, chLayout, renderName,
};
