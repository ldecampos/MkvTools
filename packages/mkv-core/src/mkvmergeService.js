const { spawn } = require('child_process');
const mkvmergeSetup = require('./mkvmergeSetup');
const { detectVariant } = require('./langData');
const {
  dedupeBestPerLang, parseList, matchesLang, matchesCodec, renderName,
} = require('./audioService');

function findMkvmerge() {
  const p = mkvmergeSetup.findMkvmerge();
  if (p) return p;
  throw new Error('mkvmerge not found. Install MKVToolNix from https://mkvtoolnix.download');
}

// Matroska RFC 9559 flag → trackType/variant mapping for subtitle tracks
function resolveFromMatroskaFlags(props, existingType) {
  if (existingType && existingType !== 'normal') return null; // Layer 2 already resolved it
  if (!props) return null;
  if (props.hearing_impaired)   return { trackType: 'sdh',           variant: '_SDH',         label: 'SDH' };
  if (props.commentary)         return { trackType: 'commentary',    variant: '_COMMENTARY',  label: 'Commentary' };
  if (props.text_descriptions)  return { trackType: 'accessibility', variant: '_AD',          label: 'Audio Description' };
  if (props.visual_impaired)    return { trackType: 'accessibility', variant: '_AD',          label: 'Audio Description' };
  return null;
}

// Same but for audio tracks
function resolveAudioFromMatroskaFlags(props, existingType) {
  if (existingType && existingType !== 'normal') return null;
  if (!props) return null;
  if (props.text_descriptions)  return { trackType: 'accessibility', variant: '_AD',          label: 'Audio Description' };
  if (props.visual_impaired)    return { trackType: 'accessibility', variant: '_AD',          label: 'Audio Description' };
  if (props.commentary)         return { trackType: 'commentary',    variant: '_COMMENTARY',  label: 'Commentary' };
  return null;
}

const IDENTIFY_TIMEOUT_MS = 30_000;

/** Identify tracks in a media file via mkvmerge --identify. */
async function identifyTracks(input, onLog) {
  const mkvmerge = findMkvmerge();
  return new Promise((resolve, reject) => {
    const proc = spawn(mkvmerge, ['--identify', '--identification-format', 'json', input]);
    let out = '', err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`mkvmerge --identify timed out after ${IDENTIFY_TIMEOUT_MS / 1000}s`));
    }, IDENTIFY_TIMEOUT_MS);
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => { err += d; onLog?.(d.toString().trim()); });
    proc.on('close', () => {
      clearTimeout(timer);
      let info;
      try { info = JSON.parse(out); }
      catch (e) { return reject(new Error(`Could not read file. ${err.slice(0, 160)}`)); }
      const containerDuration = info.container?.properties?.duration ?? 0;
      const tracks = (info.tracks || []).map(t => {
        const lang = (t.properties?.language || 'und').toLowerCase();
        const name = t.properties?.track_name || '';
        const props = t.properties || {};

        // Layer 2: keyword detection from track name
        const variantInfo = detectVariant(name, lang);

        let trackType   = variantInfo?.trackType  || 'normal';
        let variant     = variantInfo?.variant    || null;
        let variantLabel = variantInfo?.label     || null;

        // Layer 1: Matroska RFC 9559 flags override Layer 2 when Layer 2 found nothing specific
        if (t.type === 'subtitles') {
          const flagMatch = resolveFromMatroskaFlags(props, trackType);
          if (flagMatch) { trackType = flagMatch.trackType; variant = flagMatch.variant; variantLabel = flagMatch.label; }
        } else if (t.type === 'audio') {
          const flagMatch = resolveAudioFromMatroskaFlags(props, trackType);
          if (flagMatch) { trackType = flagMatch.trackType; variant = flagMatch.variant; variantLabel = flagMatch.label; }
        }

        const track = {
          id: t.id,
          type: t.type,
          codec: t.codec,
          lang,
          name,
          channels: props.audio_channels || null,
          duration: props.duration || containerDuration,
          forced: !!props.forced_track,
          default: !!props.default_track,
          variant,
          variantLabel,
          trackType,
          // Store original Matroska flags so produce() can write them back
          flagHearingImpaired: !!props.hearing_impaired,
          flagCommentary:      !!props.commentary,
          flagVisualImpaired:  !!props.visual_impaired,
          flagTextDescriptions:!!props.text_descriptions,
          flagOriginal:        !!props.original_language,
        };
        if (t.type === 'video') {
          track.pixelDimensions = props.pixel_dimensions || null;
          track.bitDepth        = props.color_bits_per_channel || 8;
          track.colorTransfer   = props.color_transfer_characteristics || 1;
          track.colorPrimaries  = props.color_primaries || 1;
        }
        return track;
      });
      if (tracks.length === 0) return reject(new Error('No tracks found in file'));
      resolve({ tracks, title: info.container?.properties?.title || '' });
    });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/** Decide which tracks to keep + compute new names, from filters + overrides. */
function planTracks(tracks, settings, overrides) {
  const audioLangs      = parseList(settings.audioLangs);
  const subLangs        = parseList(settings.subLangs);
  const codecFilter     = parseList(settings.audioCodecs);
  const oneSubPerLang   = !!settings.oneSubPerLang;
  const oneAudioPerLang = !!settings.oneAudioPerLang;

  // Subtitle type settings (default true except special types)
  const includeNormal       = settings.includeNormalSubs       !== false;
  const includeForced       = settings.includeForcedSubs       !== false;
  const includeSdh          = !!settings.includeSdh;
  const includeSigns        = !!settings.includeSigns;
  const includeUnknown      = settings.includeUnknownSubs      !== false;
  const includeCommentary   = !!settings.includeCommentary;
  const includeAccessibility = !!settings.includeAccessibility;

  // Multilingual forced-track name detection
  // Covers: forced/force (EN), forzado/forzat (ES/IT/CA), forçado (PT), forcé (FR), erzwungen (DE)
  const FORCED_NAME_RE = /\bfor[czç]|\berzwung/i;

  const ov = overrides || {};

  const plan = tracks.map(t => {
    if (t.type === 'video') return { ...t, keep: true, role: 'video' };

    if (t.type === 'audio') {
      if (t.trackType === 'accessibility') {
        const keep = includeAccessibility;
        return { ...t, keep, role: 'audio', dropReason: keep ? undefined : 'accessibility' };
      }
      if (t.trackType === 'commentary') {
        const keep = includeCommentary;
        return { ...t, keep, role: 'audio', dropReason: keep ? undefined : 'commentary' };
      }
      const langOk  = audioLangs.length === 0 || matchesLang(t.lang, audioLangs, t.variant);
      const codecOk = codecFilter.length === 0 || matchesCodec(t.codec, codecFilter);
      const keep = langOk && codecOk;
      const dropReason = !langOk ? 'lang' : !codecOk ? 'codec' : undefined;
      return { ...t, keep, role: 'audio', dropReason };
    }

    if (t.type === 'subtitles') {
      // Supplement Matroska forced flag with multilingual name detection
      const effectiveForced = t.forced || FORCED_NAME_RE.test(t.name || '');
      const langOk = subLangs.length === 0 || matchesLang(t.lang, subLangs, t.variant);
      let keep, dropReason;

      if (effectiveForced) {
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
      // Propagate effective forced flag so dedup buckets it correctly
      return { ...t, forced: effectiveForced, keep, role: 'subtitles', dropReason };
    }

    return { ...t, keep: false, role: t.type };
  });

  if (oneAudioPerLang) dedupeBestPerLang(plan, 'audio', false);
  if (oneSubPerLang)   dedupeBestPerLang(plan, 'subtitles', true);

  for (const p of plan) {
    if (p.role === 'video') continue;
    if (Object.prototype.hasOwnProperty.call(ov, p.id)) {
      p.keep = !!ov[p.id];
      p.manual = true;
      if (p.keep) delete p.dropReason; else p.dropReason = 'manual';
      if (!p.keep) p.bestOfLang = false;
    }
  }

  for (const p of plan) {
    if (p.role === 'audio' && p.keep)         p.newName = renderName(settings.audioNameTemplate, p);
    else if (p.role === 'subtitles' && p.keep) p.newName = renderName(settings.subNameTemplate, p);
    else if (p.role === 'audio' || p.role === 'subtitles') p.newName = '';
  }

  return plan;
}

/** Build mkvmerge flags to write back Matroska RFC 9559 type flags on kept tracks. */
function buildMatroskaFlagArgs(kept) {
  const args = [];
  for (const t of kept) {
    if (t.role === 'audio' || t.role === 'subtitles') {
      const hi  = t.trackType === 'sdh'           ? 1 : (t.flagHearingImpaired   ? 1 : 0);
      const com = t.trackType === 'commentary'     ? 1 : (t.flagCommentary        ? 1 : 0);
      const vi  = t.trackType === 'accessibility'  ? 1 : (t.flagVisualImpaired    ? 1 : 0);
      const td  = t.trackType === 'accessibility'  ? 1 : (t.flagTextDescriptions  ? 1 : 0);
      const orig = t.flagOriginal ? 1 : 0;
      // Only emit flags that differ from the neutral default (0) or that carry type info
      if (hi)   args.push('--hearing-impaired-flag',  `${t.id}:${hi}`);
      if (com)  args.push('--commentary-flag',         `${t.id}:${com}`);
      if (vi)   args.push('--visual-impaired-flag',   `${t.id}:${vi}`);
      if (td)   args.push('--text-descriptions-flag', `${t.id}:${td}`);
      if (orig) args.push('--original-flag',           `${t.id}:${orig}`);
    }
  }
  return args;
}

module.exports = { identifyTracks, planTracks, findMkvmerge, buildMatroskaFlagArgs };
