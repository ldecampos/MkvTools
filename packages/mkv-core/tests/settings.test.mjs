import { createRequire } from 'module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { BASE_DEFAULTS, createSettings } = require('../src/settings.js');

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k, def) => (k in data ? data[k] : def),
    set: (k, v) => { data[k] = v; },
  };
}

// ── BASE_DEFAULTS contract ─────────────────────────────────────────────────────

describe('BASE_DEFAULTS', () => {
  test('contains the keys that caused the commentary/accessibility bug', () => {
    expect(BASE_DEFAULTS).toHaveProperty('includeCommentary', false);
    expect(BASE_DEFAULTS).toHaveProperty('includeAccessibility', false);
  });

  test('contains userPresets so presets are never lost', () => {
    expect(BASE_DEFAULTS).toHaveProperty('userPresets');
    expect(BASE_DEFAULTS.userPresets).toEqual({});
  });

  test('contains all track-filtering keys', () => {
    const filterKeys = [
      'audioLangs', 'subLangs', 'audioCodecs',
      'oneSubPerLang', 'oneAudioPerLang',
      'includeNormalSubs', 'includeForcedSubs',
      'includeSdh', 'includeSigns', 'includeUnknownSubs',
    ];
    for (const k of filterKeys) expect(BASE_DEFAULTS).toHaveProperty(k);
  });

  test('contains all naming template keys', () => {
    const namingKeys = [
      'outputNameTemplate', 'folderNameTemplate', 'fileTitleTemplate',
      'createFolder', 'customFileTitle',
      'seriesOutputNameTemplate', 'seriesShowFolderTemplate',
      'seriesSeasonFolderTemplate', 'seriesCreateFolders',
    ];
    for (const k of namingKeys) expect(BASE_DEFAULTS).toHaveProperty(k);
  });

  test('createFolder defaults to true', () => {
    expect(BASE_DEFAULTS.createFolder).toBe(true);
  });
});

// ── createSettings – DEFAULTS merging ────────────────────────────────────────

describe('createSettings – DEFAULTS', () => {
  test('DEFAULTS equals BASE_DEFAULTS when no appDefaults supplied', () => {
    const { DEFAULTS } = createSettings(makeStore());
    expect(DEFAULTS).toEqual(BASE_DEFAULTS);
  });

  test('appDefaults keys are merged on top of BASE_DEFAULTS', () => {
    const { DEFAULTS } = createSettings(makeStore(), { ripTempPath: '/rips', createFolder: false });
    expect(DEFAULTS.ripTempPath).toBe('/rips');
    expect(DEFAULTS.createFolder).toBe(false);
  });

  test('BASE_DEFAULTS is never mutated by appDefaults', () => {
    createSettings(makeStore(), { ripTempPath: '/rips' });
    expect(BASE_DEFAULTS).not.toHaveProperty('ripTempPath');
  });

  test('appDefaults override base values, not just extend', () => {
    const { DEFAULTS } = createSettings(makeStore(), { audioLangs: 'jpn' });
    expect(DEFAULTS.audioLangs).toBe('jpn');
  });
});

// ── createSettings – getAll ───────────────────────────────────────────────────

describe('createSettings – getAll', () => {
  test('returns default values when the store is empty', () => {
    const { getAll } = createSettings(makeStore());
    const all = getAll();
    expect(all.includeCommentary).toBe(false);
    expect(all.includeAccessibility).toBe(false);
    expect(all.userPresets).toEqual({});
    expect(all.includeSdh).toBe(false);
    expect(all.audioLangs).toBe('spa, eng');
  });

  test('returns stored values when the store has them', () => {
    const store = makeStore({ includeCommentary: true, audioLangs: 'jpn, kor' });
    const { getAll } = createSettings(store);
    expect(getAll().includeCommentary).toBe(true);
    expect(getAll().audioLangs).toBe('jpn, kor');
  });

  test('does not expose keys that are not in DEFAULTS', () => {
    const store = makeStore({ unknownKey: 'secret' });
    const { getAll } = createSettings(store);
    expect(getAll()).not.toHaveProperty('unknownKey');
  });

  test('includes app-specific keys when passed as appDefaults', () => {
    const { getAll } = createSettings(makeStore(), { ripTempPath: '/tmp/rips' });
    expect(getAll()).toHaveProperty('ripTempPath', '/tmp/rips');
  });

  test('returns stored app-specific value over the appDefault', () => {
    const store = makeStore({ ripTempPath: '/custom/path' });
    const { getAll } = createSettings(store, { ripTempPath: '' });
    expect(getAll().ripTempPath).toBe('/custom/path');
  });
});

// ── createSettings – saveAll ──────────────────────────────────────────────────

describe('createSettings – saveAll', () => {
  test('persists partial settings — readable via getAll', () => {
    const store = makeStore();
    const { getAll, saveAll } = createSettings(store);
    saveAll({ audioLangs: 'jpn', subLangs: 'jpn' });
    expect(getAll().audioLangs).toBe('jpn');
    expect(getAll().subLangs).toBe('jpn');
  });

  test('commentary and accessibility survive a write → read round-trip', () => {
    const store = makeStore();
    const { getAll, saveAll } = createSettings(store);
    saveAll({ includeCommentary: true, includeAccessibility: true });
    expect(getAll().includeCommentary).toBe(true);
    expect(getAll().includeAccessibility).toBe(true);
  });

  test('userPresets object survives a write → read round-trip', () => {
    const store = makeStore();
    const { getAll, saveAll } = createSettings(store);
    const presets = { 'My Quality': '{title_year} {resolution}' };
    saveAll({ userPresets: presets });
    expect(getAll().userPresets).toEqual(presets);
  });

  test('saving false values is not treated as "not set"', () => {
    const store = makeStore({ createFolder: true });
    const { getAll, saveAll } = createSettings(store);
    saveAll({ createFolder: false });
    expect(getAll().createFolder).toBe(false);
  });

  test('keys not in the partial are left unchanged in the store', () => {
    const store = makeStore({ audioLangs: 'spa' });
    const { getAll, saveAll } = createSettings(store);
    saveAll({ subLangs: 'spa' });
    expect(getAll().audioLangs).toBe('spa');
  });
});

// ── Multiple independent instances ────────────────────────────────────────────

describe('createSettings – isolation', () => {
  test('two instances with different stores are independent', () => {
    const storeA = makeStore({ audioLangs: 'eng' });
    const storeB = makeStore({ audioLangs: 'jpn' });
    const a = createSettings(storeA);
    const b = createSettings(storeB);
    expect(a.getAll().audioLangs).toBe('eng');
    expect(b.getAll().audioLangs).toBe('jpn');
  });

  test('saving to one instance does not affect the other', () => {
    const storeA = makeStore();
    const storeB = makeStore();
    const a = createSettings(storeA);
    const b = createSettings(storeB);
    a.saveAll({ audioLangs: 'fra' });
    expect(b.getAll().audioLangs).toBe('spa, eng');
  });
});
