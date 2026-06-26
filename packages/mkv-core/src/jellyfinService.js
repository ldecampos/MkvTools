const https = require('https');
const http = require('http');
const { URL } = require('url');

const jellyfinService = {
  async refreshLibrary({ serverUrl, apiKey, onLog }) {
    if (!serverUrl || !apiKey) { onLog?.('Jellyfin not configured, skipping'); return false; }
    const base = serverUrl.replace(/\/+$/, '');

    return new Promise((resolve) => {
      let u;
      try { u = new URL(`${base}/Library/Refresh`); }
      catch { onLog?.('Jellyfin URL invalid'); return resolve(false); }

      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Authorization': `MediaBrowser Token="${apiKey}"`, 'Content-Length': 0 },
        timeout: 10000
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 204 || res.statusCode === 200) {
            onLog?.('Jellyfin scan started — metadata will download automatically');
            resolve(true);
          } else if (res.statusCode === 401) {
            onLog?.('Jellyfin error: invalid API key (401)'); resolve(false);
          } else {
            onLog?.(`Jellyfin returned status ${res.statusCode}`); resolve(false);
          }
        });
      });
      req.on('error', e => { onLog?.(`Jellyfin refresh failed: ${e.message}`); resolve(false); });
      req.on('timeout', () => { req.destroy(); onLog?.('Jellyfin request timed out'); resolve(false); });
      req.end();
    });
  }
};

module.exports = { jellyfinService };
