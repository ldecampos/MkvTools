import { createRequire } from 'module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { guessFromFilename } = require('../src/filenameParser.js');

describe('guessFromFilename', () => {
  test('detects SxxExx series pattern', () => {
    const r = guessFromFilename('/media/Breaking.Bad.S03E07.1080p.mkv');
    expect(r.type).toBe('series');
    expect(r.title).toBe('Breaking Bad');
    expect(r.season).toBe(3);
    expect(r.episode).toBe(7);
  });

  test('detects NxNN series pattern', () => {
    const r = guessFromFilename('/media/The.Wire.4x05.mkv');
    expect(r.type).toBe('series');
    expect(r.season).toBe(4);
    expect(r.episode).toBe(5);
  });

  test('detects Season N Episode N pattern', () => {
    const r = guessFromFilename('/media/My.Show.Season.2.Episode.10.mkv');
    expect(r.type).toBe('series');
    expect(r.season).toBe(2);
    expect(r.episode).toBe(10);
  });

  test('extracts movie title and year', () => {
    const r = guessFromFilename('/media/The.Matrix.(1999).1080p.BluRay.mkv');
    expect(r.type).toBe('movie');
    expect(r.title).toBe('The Matrix');
    expect(r.year).toBe('1999');
  });

  test('strips encoding tags from movie title', () => {
    const r = guessFromFilename('/media/Inception.2010.1080p.BluRay.x264-GROUP.mkv');
    expect(r.type).toBe('movie');
    expect(r.title).toBe('Inception');
    expect(r.year).toBe('2010');
  });

  test('applies title case to all-lowercase title', () => {
    const r = guessFromFilename('/media/the.godfather.1972.remux.mkv');
    expect(r.title).toBe('The Godfather');
  });

  test('returns empty title for unguessable name', () => {
    const r = guessFromFilename('/media/DISC1.mkv');
    expect(r.type).toBe('movie');
    expect(r.year).toBe('');
  });
});
