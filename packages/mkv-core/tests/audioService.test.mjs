import { createRequire } from 'module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { parseList, matchesLang, matchesCodec, dedupeBestPerLang } = require('../src/audioService.js');

describe('parseList', () => {
  test('splits comma-separated string', () => {
    expect(parseList('spa, eng')).toEqual(['spa', 'eng']);
  });
  test('normalises to lowercase and trims', () => {
    expect(parseList('SPA ,  ENG ')).toEqual(['spa', 'eng']);
  });
  test('returns empty array for falsy input', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList(null)).toEqual([]);
  });
  test('handles array input', () => {
    expect(parseList(['SPA', 'ENG'])).toEqual(['spa', 'eng']);
  });
});

describe('matchesLang', () => {
  test('matches by ISO-3 code', () => {
    expect(matchesLang('spa', ['spa'], null)).toBe(true);
  });
  test('matches ISO-2 code against ISO-3 track lang', () => {
    expect(matchesLang('spa', ['es'], null)).toBe(true);
  });
  test('returns false for non-matching lang', () => {
    expect(matchesLang('fra', ['spa', 'eng'], null)).toBe(false);
  });
  test('matches regional variant when specified', () => {
    expect(matchesLang('spa', ['es-la'], 'es-LA')).toBe(true);
    expect(matchesLang('spa', ['es-la'], 'es-ES')).toBe(false);
  });
});

describe('matchesCodec', () => {
  test('matches codec by substring', () => {
    expect(matchesCodec('A_DTS/MA', ['dts'])).toBe(true);
  });
  test('returns false when codec not in wanted list', () => {
    expect(matchesCodec('A_AAC', ['dts', 'truehd'])).toBe(false);
  });
});

describe('dedupeBestPerLang', () => {
  function makeAudioTrack(id, lang, codec, channels) {
    return { id, lang, codec, channels, role: 'audio', keep: true };
  }

  test('keeps highest-quality track per language', () => {
    const plan = [
      makeAudioTrack(1, 'eng', 'A_AC3', 6),
      makeAudioTrack(2, 'eng', 'A_TRUEHD', 8),
      makeAudioTrack(3, 'spa', 'A_AC3', 2),
    ];
    dedupeBestPerLang(plan, 'audio', false);
    const keptIds = plan.filter(p => p.keep).map(p => p.id);
    expect(keptIds).toContain(2); // TrueHD wins over AC3
    expect(keptIds).not.toContain(1);
    expect(keptIds).toContain(3); // Spanish has no duplicate
  });

  test('marks winner with bestOfLang=true', () => {
    const plan = [
      makeAudioTrack(1, 'eng', 'A_AC3', 6),
      makeAudioTrack(2, 'eng', 'A_DTS/MA', 6),
    ];
    dedupeBestPerLang(plan, 'audio', false);
    const winner = plan.find(p => p.id === 2);
    expect(winner.bestOfLang).toBe(true);
  });

  test('does not touch tracks from other roles', () => {
    const plan = [
      makeAudioTrack(1, 'eng', 'A_AC3', 6),
      { id: 99, lang: 'eng', codec: 'S_TEXT/UTF8', role: 'subtitles', keep: true },
    ];
    dedupeBestPerLang(plan, 'audio', false);
    expect(plan.find(p => p.id === 99).keep).toBe(true);
  });

  test('keeps separate buckets for forced subtitle tracks', () => {
    const plan = [
      { id: 1, lang: 'eng', codec: 'S_HDMV/PGS', role: 'subtitles', keep: true, forced: true },
      { id: 2, lang: 'eng', codec: 'S_TEXT/UTF8', role: 'subtitles', keep: true, forced: false },
    ];
    dedupeBestPerLang(plan, 'subtitles', true);
    // Both kept: forced and non-forced are different buckets
    expect(plan.find(p => p.id === 1).keep).toBe(true);
    expect(plan.find(p => p.id === 2).keep).toBe(true);
  });
});
