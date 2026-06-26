const fs = require('fs');
const path = require('path');
const os = require('os');

function createStore(filename) {
  const STORE_PATH = path.join(os.homedir(), filename);

  function load() {
    try {
      if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch (e) { console.error('Failed to load settings:', e.message); }
    return {};
  }

  function save(data) {
    try {
      const tmp = STORE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, STORE_PATH);
    } catch (e) { console.error('Failed to save settings:', e.message); }
  }

  let _data = load();

  return {
    get(key, defaultValue) { return _data[key] !== undefined ? _data[key] : defaultValue; },
    set(key, value) { _data[key] = value; save(_data); }
  };
}

module.exports = { createStore };
