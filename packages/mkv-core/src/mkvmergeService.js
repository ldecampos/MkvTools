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

/** Identify tracks in a media file via mkvmerge --identify. */
async function identifyTracks(input, onLog) {
  const mkvmerge = findMkvmerge();
  return new Promise((resolve, reject) => {
    const proc = spawn(mkvmerge, ['--identify', '--identification-format', 'json', input]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => { err += d; onLog?.(d.toString().trim()); });
    proc.on('close', () => {
      let info;
      try { info = JSON.parse(out); }
      catch (e) { return reject(new Error(`Could not read file. ${err.slice(0, 160)}`)); }
      const tracks = (info.tracks || []).map(t => {
        const lang = (t.properties?.language || 'und').toLowerCase();
        const name = t.properties?.track_name || '';
        const variantInfo = detectVariant(name, lang);
        return {
          id: t.id,
          type: t.type,
          codec: t.codec,
          lang,
          name,
          channels: t.properties?.audio_channels || null,
          forced: !!t.properties?.forced_track,
          default: !!t.properties?.default_track,
          variant: variantInfo?.variant || null,
          variantLabel: variantInfo?.label || null,
          trackType: variantInfo?.trackType || 'normal',
        };
      });
      if (tracks.length === 0) return reject(new Error('No tracks found in file'));
      resolve({ tracks, title: info.container?.properties?.title || '' });
    });
    proc.on('error', reject);
  });
}

/** Decide which tracks to keep + compute new names, from filters + overrides. */
function planTracks(tracks, settings, overrides) {
  const audioLangs = parseList(settings.audioLangs);
  const subLangs = parseList(settings.subLangs);
  const codecFilter = parseList(settings.audioCodecs);
  const oneSubPerLang = !!settings.oneSubPerLang;
  const oneAudioPerLang = !!settings.oneAudioPerLang;
  const ov = overrides || {};

  const plan = tracks.map(t => {
    if (t.type === 'video') return { ...t, keep: true, role: 'video' };

    if (t.trackType === 'accessibility') return { ...t, keep: false, role: t.type === 'audio' ? 'audio' : 'subtitles', dropReason: 'accessibility' };
    if (t.trackType === 'commentary')    return { ...t, keep: false, role: t.type === 'audio' ? 'audio' : 'subtitles', dropReason: 'commentary' };

    if (t.type === 'audio') {
      const langOk = audioLangs.length === 0 || matchesLang(t.lang, audioLangs, t.variant);
      const codecOk = codecFilter.length === 0 || matchesCodec(t.codec, codecFilter);
      return { ...t, keep: langOk && codecOk, role: 'audio' };
    }
    if (t.type === 'subtitles') {
      const langOk = subLangs.length === 0 || matchesLang(t.lang, subLangs, t.variant);
      return { ...t, keep: langOk, role: 'subtitles' };
    }
    return { ...t, keep: false, role: t.type };
  });

  if (oneAudioPerLang) dedupeBestPerLang(plan, 'audio', false);
  if (oneSubPerLang) dedupeBestPerLang(plan, 'subtitles', true);

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
    if (p.role === 'audio' && p.keep) p.newName = renderName(settings.audioNameTemplate, p);
    else if (p.role === 'subtitles' && p.keep) p.newName = renderName(settings.subNameTemplate, p);
    else if (p.role === 'audio' || p.role === 'subtitles') p.newName = '';
  }

  return plan;
}

module.exports = { identifyTracks, planTracks, findMkvmerge };
