'use strict';
const fs = require('fs');
const {
  parseList, matchesLang, matchesCodec,
  dedupeBestPerLang, renderName, qualityScore,
} = require('@mkv-tools/core/src/audioService');

// ── Video source quality scoring ───────────────────────────────────────────
// Priority (highest to lowest):
//   1. Resolution   — 4K vs 1080p is unambiguous
//   2. HDR          — wider dynamic range at same resolution
//   3. Bitrate/px   — high-bitrate H.264 beats low-bitrate H.265 (log scale)
//   4. Bit depth    — 10-bit > 8-bit as tiebreaker within similar bitrates
//   5. Codec        — final tiebreaker when everything else is equal

const CODEC_RANK = {
  'V_AV1': 4, 'V_MPEGH/ISO/HEVC': 3, 'V_MPEG4/ISO/AVC': 2, 'V_MPEG2': 1,
};

function parsePixels(dim) {
  if (!dim) return 0;
  const [w, h] = dim.split('x').map(Number);
  return (w || 0) * (h || 0);
}

function resolutionBucket(pixels) {
  if (pixels >= 3840 * 1600) return 4; // 4K (covers 4096 and 2.39:1 crops)
  if (pixels >= 1920 * 800)  return 3; // 1080p
  if (pixels >= 1280 * 536)  return 2; // 720p
  return 1;                             // SD
}

function videoScore(source, track) {
  const pixels = parsePixels(track.pixelDimensions);
  const resBkt = resolutionBucket(pixels);

  // HDR: PQ (transfer=16), HLG (transfer=18), or BT.2020 primaries (=9)
  const hdr = (track.colorTransfer === 16 || track.colorTransfer === 18
            || track.colorPrimaries === 9) ? 2 : 1;

  // Estimated bitrate per pixel on a log scale (0-100).
  // Container size is a valid proxy: video is ~85-95% of total bitrate in typical rips.
  // This makes a 25 Mbps H.264 remux beat a 4 Mbps H.265 WEB-DL regardless of codec.
  let bppScore = 50; // neutral fallback if file is unreadable
  const durSec = (track.duration || 0) / 1e9;
  if (durSec > 10 && pixels > 0) {
    try {
      const bytes = fs.statSync(source.file).size;
      const bitsPerPixelSec = (bytes * 8) / (durSec * pixels);
      bppScore = Math.round(Math.log1p(bitsPerPixelSec) * 20); // ~0-100
    } catch (_) {}
  }

  const depth = (track.bitDepth || 8) >= 10 ? 2 : 1;
  const codec = CODEC_RANK[track.codec] || 1;

  return resBkt  * 1e9
       + hdr     * 1e7
       + bppScore * 1e5
       + depth   * 1e3
       + codec;
}

/**
 * Pick the source index that contributes the best video track.
 * sources: [{ file, tracks }]
 */
function pickVideoSource(sources) {
  let best = { score: -1, si: 0 };
  for (let si = 0; si < sources.length; si++) {
    for (const t of (sources[si].tracks || []).filter(t => t.type === 'video')) {
      const score = videoScore(sources[si], t);
      if (score > best.score) best = { score, si };
    }
  }
  return best.si;
}

/**
 * Build the merged track plan from multiple sources.
 *
 * Each entry: { ...track, sourceIndex, globalId, keep, role, newName, dropReason? }
 * globalId = "sourceIndex:trackId" — used as override key from the renderer.
 *
 * overrides: { [globalId]: true|false }  explicit keep/drop from user
 */
function planMergeTracks(sources, settings, overrides = {}, forcedVideoSource = null) {
  const audioLangs     = parseList(settings.audioLangs);
  const subLangs       = parseList(settings.subLangs);
  const codecFilter    = parseList(settings.audioCodecs);
  const oneAudio            = !!settings.oneAudioPerLang;
  const oneSub              = !!settings.oneSubPerLang;
  const includeNormal       = settings.includeNormalSubs    !== false;
  const includeForced       = settings.includeForcedSubs    !== false;
  const includeSdh          = !!settings.includeSdh;
  const includeSigns        = !!settings.includeSigns;
  const includeCommentary   = !!settings.includeCommentary;
  const includeAccessibility = !!settings.includeAccessibility;
  const includeUnknown      = settings.includeUnknownSubs   !== false;

  const videoSourceIndex = forcedVideoSource != null ? forcedVideoSource : pickVideoSource(sources);
  const plan = [];

  // ── Video (only from selected source) ──────────────────────────────────────
  for (const t of (sources[videoSourceIndex].tracks || []).filter(t => t.type === 'video')) {
    const gid = `${videoSourceIndex}:${t.id}`;
    plan.push({ ...t, sourceIndex: videoSourceIndex, globalId: gid, keep: true, role: 'video' });
  }

  // ── Audio (all sources combined) ───────────────────────────────────────────
  for (let si = 0; si < sources.length; si++) {
    for (const t of (sources[si].tracks || []).filter(t => t.type === 'audio')) {
      const gid = `${si}:${t.id}`;
      let keep, dropReason;
      if (t.trackType === 'accessibility') {
        keep = includeAccessibility;
        dropReason = keep ? undefined : 'accessibility';
      } else if (t.trackType === 'commentary') {
        keep = includeCommentary;
        dropReason = keep ? undefined : 'commentary';
      } else {
        const langOk  = audioLangs.length === 0 || matchesLang(t.lang, audioLangs, t.variant);
        const codecOk = codecFilter.length === 0 || matchesCodec(t.codec, codecFilter);
        keep = langOk && codecOk;
        dropReason = !langOk ? 'lang' : !codecOk ? 'codec' : undefined;
      }
      plan.push({ ...t, sourceIndex: si, globalId: gid, keep, role: 'audio', dropReason });
    }
  }

  // ── Subtitles (all sources combined) ───────────────────────────────────────
  for (let si = 0; si < sources.length; si++) {
    for (const t of (sources[si].tracks || []).filter(t => t.type === 'subtitles')) {
      const gid = `${si}:${t.id}`;
      const langOk = subLangs.length === 0 || matchesLang(t.lang, subLangs, t.variant);
      let keep, dropReason;

      if (t.forced) {
        keep = includeForced && langOk;
        dropReason = !includeForced ? 'forced_disabled' : (!langOk ? 'lang' : undefined);
      } else if (t.trackType === 'sdh') {
        keep = includeSdh && langOk;
        dropReason = !includeSdh ? 'sdh_disabled' : (!langOk ? 'lang' : undefined);
      } else if (t.trackType === 'signs') {
        keep = includeSigns && langOk;
        dropReason = !includeSigns ? 'signs_disabled' : (!langOk ? 'lang' : undefined);
      } else if (t.trackType === 'commentary') {
        keep = includeCommentary && langOk;
        dropReason = !includeCommentary ? 'commentary' : (!langOk ? 'lang' : undefined);
      } else if (t.trackType === 'accessibility') {
        keep = includeAccessibility && langOk;
        dropReason = !includeAccessibility ? 'accessibility' : (!langOk ? 'lang' : undefined);
      } else if (t.trackType === 'unknown') {
        keep = includeUnknown && langOk;
        dropReason = !includeUnknown ? 'unknown_disabled' : (!langOk ? 'lang' : undefined);
      } else {
        keep = includeNormal && langOk;
        dropReason = !includeNormal ? 'normal_disabled' : (!langOk ? 'lang' : undefined);
      }

      plan.push({ ...t, sourceIndex: si, globalId: gid, keep, role: 'subtitles', dropReason });
    }
  }

  // ── Dedup: best quality per language across all sources ────────────────────
  if (oneAudio) dedupeBestPerLang(plan, 'audio', false);
  if (oneSub)   dedupeBestPerLang(plan, 'subtitles', true);

  // ── User overrides (always win, applied after dedup) ──────────────────────
  for (const p of plan) {
    if (p.role === 'video') continue;
    if (Object.prototype.hasOwnProperty.call(overrides, p.globalId)) {
      p.keep = !!overrides[p.globalId];
      p.manual = true;
      if (p.keep) delete p.dropReason; else p.dropReason = 'manual';
      if (!p.keep) p.bestOfLang = false;
    }
  }

  // ── Track names ────────────────────────────────────────────────────────────
  for (const p of plan) {
    if (p.role === 'audio' && p.keep)     p.newName = renderName(settings.audioNameTemplate, p);
    else if (p.role === 'subtitles' && p.keep) p.newName = renderName(settings.subNameTemplate, p);
    else p.newName = '';
  }

  return { videoSourceIndex, plan };
}

module.exports = { planMergeTracks, pickVideoSource };
