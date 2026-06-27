import { createRequire } from 'module';
import { describe, test, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { renderTemplate } = require('../src/nameTemplate.js');

describe('renderTemplate', () => {
  test('replaces known tokens', () => {
    expect(renderTemplate('{lang} {codec_short}', { lang: 'English', codec_short: 'DTS-HD MA' }))
      .toBe('English DTS-HD MA');
  });

  test('leaves unknown tokens as-is', () => {
    expect(renderTemplate('{foo}', {})).toBe('{foo}');
  });

  test('returns empty string for falsy template', () => {
    expect(renderTemplate('', {})).toBe('');
    expect(renderTemplate(null, {})).toBe('');
  });

  test('cleans trailing separator when trailing token resolves to empty', () => {
    expect(renderTemplate('{lang} · {forced}', { lang: 'English', forced: '' }))
      .toBe('English');
  });

  test('collapses double separators', () => {
    expect(renderTemplate('{a} · · {b}', { a: 'X', b: 'Y' })).toBe('X · Y');
  });

  test('removes empty parentheses', () => {
    expect(renderTemplate('{lang} ({forced})', { lang: 'Spanish', forced: '' }))
      .toBe('Spanish');
  });

  test('expands {rg_X} to X (release group literal)', () => {
    expect(renderTemplate('{rg_EVOLVE}', {})).toBe('EVOLVE');
  });

  test('handles undefined ctx values as empty string', () => {
    expect(renderTemplate('{iso2}', { iso2: undefined })).toBe('');
  });
});
