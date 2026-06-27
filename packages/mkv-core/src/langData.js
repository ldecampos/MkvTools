/**
 * Language data using Node's built-in Intl.DisplayNames for full ISO 639 coverage.
 * - iso2 <-> iso3 mapping (Intl doesn't convert between these, so we keep a table)
 * - display names in ANY language via Intl ({lang_xx} for any xx)
 * - native name = the language's name in its own language
 */

// iso3 (and common bibliographic alts) -> iso2, for the codes Blu-rays use.
// Intl works best with iso2, so we normalize to iso2 internally.
const ISO3_TO_ISO2 = {
  spa:'es', eng:'en', fra:'fr', fre:'fr', deu:'de', ger:'de', ita:'it', por:'pt',
  nld:'nl', dut:'nl', jpn:'ja', zho:'zh', chi:'zh', kor:'ko', rus:'ru', ara:'ar',
  hin:'hi', pol:'pl', swe:'sv', nor:'no', dan:'da', fin:'fi', ces:'cs', cze:'cs',
  hun:'hu', ell:'el', gre:'el', tur:'tr', tha:'th', heb:'he', cat:'ca', eus:'eu',
  baq:'eu', glg:'gl', ukr:'uk', ron:'ro', rum:'ro', ind:'id', vie:'vi', msa:'ms',
  may:'ms', fil:'fil', tgl:'tl', swa:'sw', tam:'ta', tel:'te', mal:'ml', kan:'kn',
  ben:'bn', mar:'mr', guj:'gu', pan:'pa', urd:'ur', fas:'fa', per:'fa', heb2:'he',
  isl:'is', ice:'is', gle:'ga', cym:'cy', wel:'cy', slk:'sk', slo:'sk', slv:'sl',
  hrv:'hr', srp:'sr', bul:'bg', lav:'lv', lit:'lt', est:'et', mkd:'mk', mac:'mk',
  sqi:'sq', alb:'sq', hye:'hy', arm:'hy', kat:'ka', geo:'ka', aze:'az', kaz:'kk',
  uzb:'uz', mon:'mn', nep:'ne', sin:'si', mya:'my', bur:'my', khm:'km', lao:'lo',
  amh:'am', yor:'yo', ibo:'ig', hau:'ha', zul:'zu', afr:'af', xho:'xh'
};

// Reverse map iso2 -> iso3 (first match)
const ISO2_TO_ISO3 = {};
for (const [i3, i2] of Object.entries(ISO3_TO_ISO2)) {
  if (!ISO2_TO_ISO3[i2]) ISO2_TO_ISO3[i2] = i3;
}

function toIso2(code) {
  if (!code) return '';
  const c = code.toLowerCase();
  if (c.length === 2) return c;
  return ISO3_TO_ISO2[c] || c;
}
function toIso3(code) {
  if (!code) return '';
  const c = code.toLowerCase();
  if (c.length === 3) return c;
  return ISO2_TO_ISO3[c] || c;
}

// Cache DisplayNames instances per display language
const dnCache = {};
function displayNames(displayLang) {
  if (!dnCache[displayLang]) {
    try { dnCache[displayLang] = new Intl.DisplayNames([displayLang], { type: 'language' }); }
    catch (_) { dnCache[displayLang] = new Intl.DisplayNames(['en'], { type: 'language' }); }
  }
  return dnCache[displayLang];
}

// Name of `code` rendered in `displayLang` (e.g. langNameIn('jpn','es') -> 'Japonés')
function langNameIn(code, displayLang) {
  const i2 = toIso2(code);
  if (!i2 || i2 === 'und') return '';
  try {
    const name = displayNames(displayLang).of(i2);
    return name ? capitalize(name) : i2.toUpperCase();
  } catch (_) {
    return i2.toUpperCase();
  }
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Native name = language's name in its own language
function langName(code) {
  const i2 = toIso2(code);
  if (!i2 || i2 === 'und') return '';
  return langNameIn(code, i2);
}
function langNameEn(code) { return langNameIn(code, 'en'); }

// Full list of languages we have iso3 mappings for, for UI dropdowns
const ALL_LANGS = Object.keys(ISO3_TO_ISO2)
  .map(i3 => ({ iso3: i3, iso2: ISO3_TO_ISO2[i3], en: langNameIn(i3, 'en'), native: langName(i3) }))
  .filter((v, i, arr) => arr.findIndex(x => x.iso2 === v.iso2) === i)
  .sort((a, b) => a.en.localeCompare(b.en));

// Common display languages offered as ready-made {lang_xx} chips
const COMMON_DISPLAY_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt'];

// ── Regional variant detection ────────────────────────────────────────────────
// Each entry: { keywords, label, region }
// Special entries prefixed with '_' are track-type markers (not language variants)
const VARIANT_MAP = {
  // Spanish
  'es-ES': { keywords: ['castellano','castilian','spain','españa','peninsular','iberian','iberico','ibérico'], label: 'Castilian', region: 'ES' },
  'es-LA': { keywords: ['latino','latin','latam','latin american','latinoamerica','latinoamérica','hispanoamerica','hispanoamérica','mexico','latinoam'], label: 'Latin American', region: 'LA' },
  // Portuguese
  'pt-BR': { keywords: ['brazilian','brasil','brasileiro','brazil'], label: 'Brazilian', region: 'BR' },
  'pt-PT': { keywords: ['european portuguese','portugal','europeu','lusitano'], label: 'European', region: 'PT' },
  // Chinese
  'zh-TW': { keywords: ['traditional','taiwan','cantonese'], label: 'Traditional', region: 'TW' },
  'zh-CN': { keywords: ['simplified','simplified chinese','mandarin','putonghua'], label: 'Simplified', region: 'CN' },
  // French
  'fr-CA': { keywords: ['canadian french','québec','quebec','canadien'], label: 'Canadian', region: 'CA' },
  // Special track types (language-independent)
  '_AD': { keywords: ['audio description','audio descript','(ad)','[ad]','descriptive','audiodescripcion','audiodescripción','dvs','visually impaired'], label: 'Audio Description', region: null },
  '_COMMENTARY': { keywords: ['commentary','comentario del director','filmmakers','cast commentary'], label: 'Commentary', region: null },
  '_SDH': {
    keywords: [
      'sdh','hearing impaired','hard of hearing','hearing-impaired',
      'para sordos','hipoacúsicos','hipoacusicos','para hipoacúsicos',
      '[hi]','(hi)','for the deaf','closed caption','cc subtitles',
      'subtitles for the deaf','malentendants','sourd','gehörlos','surdos'
    ],
    label: 'SDH',
    region: null
  },
  '_SIGNS': {
    keywords: [
      'signs','signs & songs','signs and songs','signs/songs','signs+songs',
      'letreros','carteles','forced signs','foreign parts','foreign only',
      'solos letreros','solo letreros'
    ],
    label: 'Signs & Songs',
    region: null
  },
};

// Detect regional variant or special track type from track name.
// Returns { variant, region, label, trackType } or null.
function detectVariant(name, langCode) {
  if (!name) return null;
  const lower = name.toLowerCase();
  const baseLang = toIso2(langCode);

  // Special track types first (language-independent)
  const SPECIAL_TYPE_MAP = { _AD: 'accessibility', _COMMENTARY: 'commentary', _SDH: 'sdh', _SIGNS: 'signs' };
  for (const type of ['_AD', '_COMMENTARY', '_SDH', '_SIGNS']) {
    const entry = VARIANT_MAP[type];
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return { variant: type, region: null, label: entry.label, trackType: SPECIAL_TYPE_MAP[type] };
    }
  }

  // Language-specific regional variants
  for (const [variant, entry] of Object.entries(VARIANT_MAP)) {
    if (variant.startsWith('_')) continue;
    const variantBase = variant.split('-')[0]; // 'es', 'pt', 'zh', 'fr'
    if (baseLang !== variantBase) continue;
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return { variant, region: entry.region, label: entry.label, trackType: 'normal' };
    }
  }

  return null;
}

// All known regional variants (for UI dropdowns), keyed by base language iso2
function variantsForLang(iso2) {
  return Object.entries(VARIANT_MAP)
    .filter(([v]) => !v.startsWith('_') && v.startsWith(iso2 + '-'))
    .map(([variant, entry]) => ({ variant, label: entry.label, region: entry.region }));
}

module.exports = { langName, langNameEn, langNameIn, toIso2, toIso3, ALL_LANGS, COMMON_DISPLAY_LANGS, detectVariant, variantsForLang, VARIANT_MAP };
