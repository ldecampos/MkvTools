import { createRequire } from 'module';
import { describe, test, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { sanitize, uniqueName, buildFileCtx, buildSeriesCtx, computeOutput } =
  require('../src/outputNaming.js');

// ── sanitize ──────────────────────────────────────────────────────────────────

describe('sanitize', () => {
  test('strips characters illegal in filenames', () => {
    expect(sanitize('Movie: A/B\\C?')).toBe('Movie AB\\C?'.replace(/[/\\:*?"<>|]/g, ''));
    // Check each illegal char individually
    for (const ch of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(sanitize(`a${ch}b`)).toBe('ab');
    }
  });

  test('trims leading and trailing whitespace', () => {
    expect(sanitize('  Movie  ')).toBe('Movie');
  });

  test('falls back to "output" for empty input', () => {
    expect(sanitize('')).toBe('output');
    expect(sanitize(null)).toBe('output');
    expect(sanitize(undefined)).toBe('output');
  });

  test('falls back to "output" when all chars are stripped', () => {
    expect(sanitize('///:*?')).toBe('output');
  });

  test('preserves dots and parentheses', () => {
    expect(sanitize('The Matrix (1999)')).toBe('The Matrix (1999)');
  });
});

// ── uniqueName ────────────────────────────────────────────────────────────────

describe('uniqueName', () => {
  test('returns the path unchanged when there is no collision', () => {
    const p = '/nonexistent-xyz-99999/movie.mkv';
    expect(uniqueName(p)).toBe(p);
  });

  test('appends (1) when the path is in the plannedSet', () => {
    const p = '/out/Movie.mkv';
    const planned = new Set([p]);
    expect(uniqueName(p, planned)).toBe('/out/Movie (1).mkv');
  });

  test('increments counter until a free slot is found', () => {
    const p = '/out/Movie.mkv';
    const planned = new Set([p, '/out/Movie (1).mkv', '/out/Movie (2).mkv']);
    expect(uniqueName(p, planned)).toBe('/out/Movie (3).mkv');
  });

  test('preserves the file extension when disambiguating', () => {
    const p = '/out/File.mkv';
    const planned = new Set([p]);
    const result = uniqueName(p, planned);
    expect(result.endsWith('.mkv')).toBe(true);
    expect(result).toContain('(1)');
  });

  test('handles a path with no plannedSet collision', () => {
    const p = '/totally-unique-path/x.mkv';
    expect(uniqueName(p, new Set())).toBe(p);
  });

  // Filesystem-level collision test
  let tmpDir = null;
  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
  });

  test('appends (1) when the file already exists on disk', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkv-test-'));
    const existing = path.join(tmpDir, 'Movie.mkv');
    fs.writeFileSync(existing, '');
    expect(uniqueName(existing)).toBe(path.join(tmpDir, 'Movie (1).mkv'));
  });

  test('plannedSet takes priority over filesystem check', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkv-test-'));
    const p = path.join(tmpDir, 'Movie.mkv');
    const p1 = path.join(tmpDir, 'Movie (1).mkv');
    fs.writeFileSync(p, '');
    const planned = new Set([p1]);
    expect(uniqueName(p, planned)).toBe(path.join(tmpDir, 'Movie (2).mkv'));
  });
});

// ── buildFileCtx ──────────────────────────────────────────────────────────────

describe('buildFileCtx', () => {
  const filePath = '/media/The.Matrix.1999.mkv';

  test('uses movie.title and movie.year', () => {
    const ctx = buildFileCtx({ title: 'The Matrix', year: '1999' }, filePath, null);
    expect(ctx.title).toBe('The Matrix');
    expect(ctx.year).toBe('1999');
    expect(ctx.title_year).toBe('The Matrix (1999)');
  });

  test('falls back to filename when movie has no title', () => {
    const ctx = buildFileCtx(null, filePath, null);
    expect(ctx.title).toBe('The.Matrix.1999');
    expect(ctx.filename).toBe('The.Matrix.1999');
  });

  test('title_year equals title when year is empty', () => {
    const ctx = buildFileCtx({ title: 'Unknown', year: '' }, filePath, null);
    expect(ctx.title_year).toBe('Unknown');
  });

  test('includes filename without extension', () => {
    const ctx = buildFileCtx({ title: 'X', year: '' }, filePath, null);
    expect(ctx.filename).toBe('The.Matrix.1999');
  });
});

// ── buildSeriesCtx ────────────────────────────────────────────────────────────

describe('buildSeriesCtx', () => {
  const filePath = '/media/Breaking.Bad.S03E07.mkv';

  test('builds sxxexx with zero-padded season and episode', () => {
    const ctx = buildSeriesCtx({ title: 'Breaking Bad', season: 3, episode: 7 }, filePath, null);
    expect(ctx.sxxexx).toBe('S03E07');
    expect(ctx.season2).toBe('03');
    expect(ctx.episode2).toBe('07');
  });

  test('raw season and episode are string numbers', () => {
    const ctx = buildSeriesCtx({ title: 'Show', season: 1, episode: 5 }, filePath, null);
    expect(ctx.season).toBe('1');
    expect(ctx.episode).toBe('5');
  });

  test('sets series from movie.title', () => {
    const ctx = buildSeriesCtx({ title: 'Breaking Bad', season: 1, episode: 1 }, filePath, null);
    expect(ctx.series).toBe('Breaking Bad');
  });

  test('includes episode_title from movie.episodeTitle', () => {
    const ctx = buildSeriesCtx(
      { title: 'Breaking Bad', season: 3, episode: 7, episodeTitle: 'One Minute' },
      filePath, null
    );
    expect(ctx.episode_title).toBe('One Minute');
  });

  test('episode_title is empty string when not provided', () => {
    const ctx = buildSeriesCtx({ title: 'Show', season: 1, episode: 1 }, filePath, null);
    expect(ctx.episode_title).toBe('');
  });

  test('defaults season and episode to 0 when missing', () => {
    const ctx = buildSeriesCtx({ title: 'Show' }, filePath, null);
    expect(ctx.season).toBe('0');
    expect(ctx.episode).toBe('0');
    expect(ctx.sxxexx).toBe('S00E00');
  });
});

// ── computeOutput – movies ────────────────────────────────────────────────────

const MOVIE_SETTINGS = {
  outputPath: '/out',
  outputNameTemplate: '{title_year}',
  createFolder: false,
  folderNameTemplate: '{title_year}',
  imdbInFolder: false,
  customFileTitle: false,
  fileTitleTemplate: '{title_year}',
};

describe('computeOutput – movie', () => {
  const movie = { title: 'The Matrix', year: '1999' };
  const filePath = '/media/The.Matrix.1999.mkv';

  test('flat output when createFolder is false', () => {
    const { output } = computeOutput(filePath, movie, MOVIE_SETTINGS, false, null);
    expect(output).toBe('/out/The Matrix (1999).mkv');
  });

  test('creates subfolder when createFolder is true', () => {
    const s = { ...MOVIE_SETTINGS, createFolder: true };
    const { output } = computeOutput(filePath, movie, s, false, null);
    expect(output).toBe('/out/The Matrix (1999)/The Matrix (1999).mkv');
  });

  test('appends imdb tag to folder when imdbInFolder is true', () => {
    const s = { ...MOVIE_SETTINGS, createFolder: true, imdbInFolder: true };
    const movieWithImdb = { ...movie, imdbId: 'tt0133093' };
    const { output } = computeOutput(filePath, movieWithImdb, s, false, null);
    expect(output).toContain('[imdbid-tt0133093]');
    expect(output).toContain('/out/');
  });

  test('imdb tag not added when movie has no imdbId', () => {
    const s = { ...MOVIE_SETTINGS, createFolder: true, imdbInFolder: true };
    const { output } = computeOutput(filePath, movie, s, false, null);
    expect(output).not.toContain('imdbid');
  });

  test('fileTitle equals output name by default', () => {
    const { output, fileTitle } = computeOutput(filePath, movie, MOVIE_SETTINGS, false, null);
    expect(fileTitle).toBe('The Matrix (1999)');
    expect(output).toContain(fileTitle);
  });

  test('customFileTitle uses fileTitleTemplate', () => {
    const s = { ...MOVIE_SETTINGS, customFileTitle: true, fileTitleTemplate: '{title} [{year}]' };
    const { fileTitle } = computeOutput(filePath, movie, s, false, null);
    expect(fileTitle).toBe('The Matrix [1999]');
  });

  test('always ends with .mkv', () => {
    const { output } = computeOutput(filePath, movie, MOVIE_SETTINGS, false, null);
    expect(output.endsWith('.mkv')).toBe(true);
  });

  test('sanitizes illegal chars in output name', () => {
    const badMovie = { title: 'Movie: Two', year: '2020' };
    const { output } = computeOutput(filePath, badMovie, MOVIE_SETTINGS, false, null);
    // Check only the filename component — the path separators are expected OS chars
    const filename = path.basename(output);
    expect(filename).not.toMatch(/[/\\:*?"<>|]/);
  });

  test('falls back to filename when movie is null', () => {
    const { output } = computeOutput(filePath, null, MOVIE_SETTINGS, false, null);
    expect(output).toContain('The.Matrix.1999');
    expect(output.endsWith('.mkv')).toBe(true);
  });
});

// ── computeOutput – series ────────────────────────────────────────────────────

const SERIES_SETTINGS = {
  outputPath: '/out',
  seriesOutputNameTemplate: '{series} - {sxxexx} - {episode_title}',
  seriesCreateFolders: false,
  seriesShowFolderTemplate: '{series} ({year})',
  seriesSeasonFolderTemplate: 'Season {season2}',
  imdbInFolder: false,
  seriesCustomFileTitle: false,
  seriesFileTitleTemplate: '',
};

describe('computeOutput – series', () => {
  const movie = { title: 'Breaking Bad', year: '2008', season: 3, episode: 7, episodeTitle: 'One Minute' };
  const filePath = '/media/Breaking.Bad.S03E07.mkv';

  test('flat output when seriesCreateFolders is false', () => {
    const { output } = computeOutput(filePath, movie, SERIES_SETTINGS, true, null);
    expect(output).toBe('/out/Breaking Bad - S03E07 - One Minute.mkv');
  });

  test('creates show and season folders when seriesCreateFolders is true', () => {
    const s = { ...SERIES_SETTINGS, seriesCreateFolders: true };
    const { output } = computeOutput(filePath, movie, s, true, null);
    expect(output).toContain('/out/');
    expect(output).toContain('Breaking Bad (2008)');
    expect(output).toContain('Season 03');
    expect(output.endsWith('.mkv')).toBe(true);
  });

  test('sxxexx zero-pads season and episode correctly', () => {
    const ep = { title: 'Show', year: '2000', season: 1, episode: 5, episodeTitle: 'Pilot' };
    const { output } = computeOutput('/media/x.mkv', ep, SERIES_SETTINGS, true, null);
    expect(output).toContain('S01E05');
  });

  test('imdb tag appended to show folder when imdbInFolder is true', () => {
    const s = { ...SERIES_SETTINGS, seriesCreateFolders: true, imdbInFolder: true };
    const movieWithImdb = { ...movie, imdbId: 'tt0903747' };
    const { output } = computeOutput(filePath, movieWithImdb, s, true, null);
    expect(output).toContain('[imdbid-tt0903747]');
  });

  test('seriesCustomFileTitle uses seriesFileTitleTemplate', () => {
    const s = {
      ...SERIES_SETTINGS,
      seriesCustomFileTitle: true,
      seriesFileTitleTemplate: '{sxxexx} - {episode_title}',
    };
    const { fileTitle } = computeOutput(filePath, movie, s, true, null);
    expect(fileTitle).toBe('S03E07 - One Minute');
  });

  test('always ends with .mkv', () => {
    const { output } = computeOutput(filePath, movie, SERIES_SETTINGS, true, null);
    expect(output.endsWith('.mkv')).toBe(true);
  });
});
