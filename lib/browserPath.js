const fs = require('fs');

// ---- Locating a Chrome/Chromium/Edge binary already on this machine ----
// We deliberately don't bundle/download a browser (that's a large, failure-
// prone install step - see the better-sqlite3 lesson). Nearly every Windows/
// Mac machine already has Chrome or Edge, so we just find it. Shared by
// every PDF generator in this app (offers, challans, ...).
function findBrowser() {
  if (process.env.PDF_CHROME_PATH && fs.existsSync(process.env.PDF_CHROME_PATH)) {
    return process.env.PDF_CHROME_PATH;
  }
  const candidates = [
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', // dev/test fallback
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

module.exports = { findBrowser };
