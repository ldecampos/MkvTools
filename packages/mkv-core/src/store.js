const fs = require('fs');
const path = require('path');
const os = require('os');

function createStore(filename, legacyFilename) {
  const STORE_PATH = path.join(os.homedir(), filename);
  const LEGACY_PATH = legacyFilename ? path.join(os.homedir(), legacyFilename) : null;

  function save(data) {
    try {
      const tmp = STORE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, STORE_PATH);
    } catch (e) { console.error('Failed to save settings:', e.message); }
  }

  function load() {
    try {
      if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      // One-time migration from legacy path
      if (LEGACY_PATH && fs.existsSync(LEGACY_PATH)) {
        const data = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
        save(data);
        return data;
      }
    } catch (e) { console.error('Failed to load settings:', e.message); }
    return {};
  }

  let _data = load();

  return {
    get(key, defaultValue) { return _data[key] !== undefined ? _data[key] : defaultValue; },
    set(key, value) { _data[key] = value; save(_data); }
  };
}

module.exports = { createStore };
