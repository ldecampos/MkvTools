import { createRequire } from 'module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { planTracks } = require('../src/mkvmergeService.js');

function video(id = 0)   { return { id, type: 'video',     codec: 'V_MPEGH/ISO/HEVC', lang: 'und', trackType: 'normal', forced: false, default: false }; }
function audio(id, lang, codec = 'A_AC3', channels = 6, trackType = 'normal') {
  return { id, type: 'audio', codec, lang, channels, trackType, forced: false, default: false, variant: null };
}
function sub(id, lang, trackType = 'normal', forced = false) {
  return { id, type: 'subtitles', codec: 'S_TEXT/UTF8', lang, trackType, forced, default: false, variant: null, name: '' };
}

const BASE_SETTINGS = {
  audioLangs: '', subLangs: '', audioCodecs: '',
  oneAudioPerLang: false, oneSubPerLang: false,
  includeNormalSubs: true, includeForcedSubs: true,
  includeSdh: false, includeSigns: false, includeUnknown: true,
  includeCommentary: false, includeAccessibility: false,
};

describe('planTracks – video', () => {
  test('always keeps video tracks', () => {
    const [v] = planTracks([video()], BASE_SETTINGS);
    expect(v.keep).toBe(true);
    expect(v.role).toBe('video');
  });
});

describe('planTracks – audio language filter', () => {
  test('keeps tracks matching audioLangs', () => {
    const tracks = [video(), audio(1, 'eng'), audio(2, 'fra')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, audioLangs: 'eng' });
    const audio1 = plan.find(p => p.id === 1);
    const audio2 = plan.find(p => p.id === 2);
    expect(audio1.keep).toBe(true);
    expect(audio2.keep).toBe(false);
    expect(audio2.dropReason).toBe('lang');
  });

  test('keeps all audio tracks when audioLangs is empty', () => {
    const tracks = [video(), audio(1, 'eng'), audio(2, 'jpn')];
    const plan = planTracks(tracks, BASE_SETTINGS);
    expect(plan.find(p => p.id === 1).keep).toBe(true);
    expect(plan.find(p => p.id === 2).keep).toBe(true);
  });
});

describe('planTracks – commentary and accessibility', () => {
  test('drops commentary audio when includeCommentary=false', () => {
    const tracks = [video(), audio(1, 'eng', 'A_AC3', 2, 'commentary')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, includeCommentary: false });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
    expect(plan.find(p => p.id === 1).dropReason).toBe('commentary');
  });

  test('keeps commentary audio when includeCommentary=true', () => {
    const tracks = [video(), audio(1, 'eng', 'A_AC3', 2, 'commentary')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, includeCommentary: true });
    expect(plan.find(p => p.id === 1).keep).toBe(true);
  });

  test('drops accessibility audio when includeAccessibility=false', () => {
    const tracks = [video(), audio(1, 'eng', 'A_AC3', 2, 'accessibility')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, includeAccessibility: false });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
  });
});

describe('planTracks – subtitle filters', () => {
  test('drops SDH when includeSdh=false', () => {
    const tracks = [video(), sub(1, 'eng', 'sdh')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, includeSdh: false });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
    expect(plan.find(p => p.id === 1).dropReason).toBe('sdh_disabled');
  });

  test('keeps forced subs that match lang', () => {
    const tracks = [video(), sub(1, 'eng', 'normal', true)];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, subLangs: 'eng', includeForcedSubs: true });
    expect(plan.find(p => p.id === 1).keep).toBe(true);
  });

  test('drops forced subs when includeForcedSubs=false', () => {
    const tracks = [video(), sub(1, 'eng', 'normal', true)];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, includeForcedSubs: false });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
    expect(plan.find(p => p.id === 1).dropReason).toBe('forced_disabled');
  });

  test('detects forced sub from name pattern', () => {
    const t = { ...sub(1, 'eng'), name: 'English Forced' };
    const plan = planTracks([video(), t], { ...BASE_SETTINGS, includeForcedSubs: false });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
    expect(plan.find(p => p.id === 1).dropReason).toBe('forced_disabled');
  });
});

describe('planTracks – oneAudioPerLang dedup', () => {
  test('retains only best-quality track per language', () => {
    const tracks = [
      video(),
      audio(1, 'eng', 'A_AC3', 6),
      audio(2, 'eng', 'A_TRUEHD', 8),
    ];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, oneAudioPerLang: true });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
    expect(plan.find(p => p.id === 2).keep).toBe(true);
  });
});

describe('planTracks – manual overrides', () => {
  test('override can force-keep a track the filter would drop', () => {
    const tracks = [video(), audio(1, 'fra')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, audioLangs: 'eng' }, { 1: true });
    expect(plan.find(p => p.id === 1).keep).toBe(true);
    expect(plan.find(p => p.id === 1).manual).toBe(true);
  });

  test('override can force-drop a track the filter would keep', () => {
    const tracks = [video(), audio(1, 'eng')];
    const plan = planTracks(tracks, { ...BASE_SETTINGS, audioLangs: 'eng' }, { 1: false });
    expect(plan.find(p => p.id === 1).keep).toBe(false);
    expect(plan.find(p => p.id === 1).dropReason).toBe('manual');
  });
});
