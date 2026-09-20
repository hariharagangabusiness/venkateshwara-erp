const fs = require('fs');
const { execFileSync } = require('child_process');

// A `chromium`/`chromium-browser`/`google-chrome` binary resolvable on PATH -
// this is how the Nix-installed Chromium from nixpacks.toml shows up in a
// Railway container at runtime. Nix wraps its binaries with the correct
// library paths baked in, so this is a real, fully-working browser (unlike
// @sparticuz/chromium's bundle, which still depends on system shared
// libraries - libnss3.so etc - that a bare Nixpacks container doesn't have).
function findOnPath() {
  const names = process.platform === 'win32' ? [] : ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];
  for (const name of names) {
    try {
      const resolved = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch (e) { /* not on PATH - try the next candidate */ }
  }
  return null;
}

// ---- Locating a Chrome/Chromium/Edge binary already on this machine ----
// We first look for a browser already installed on the machine (fast, no
// extra download) - this is the common case on a developer's own Windows/
// Mac laptop. Shared by every PDF generator in this app (offers, challans,
// purchase orders, invoices, service reports).
function findBrowser() {
  if (process.env.PDF_CHROME_PATH && fs.existsSync(process.env.PDF_CHROME_PATH)) {
    return process.env.PDF_CHROME_PATH;
  }
  const onPath = findOnPath();
  if (onPath) return onPath;
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
 
// ---- Fallback for containerized deploys (Railway, Render, Docker, ...) ----
// Those Linux containers never have Chrome/Edge pre-installed, so
// findBrowser() above always returns null there - that's what was showing
// the "No Chrome/Edge/Chromium browser found on this machine" popup in
// production. @sparticuz/chromium ships a headless Chromium build (plus the
// exact launch flags it needs) specifically meant to run in a stripped-down
// serverless/container Linux environment without any system Chrome install,
// so we use it whenever findBrowser() comes up empty.
async function getLaunchOptions() {
  const executablePath = findBrowser();
  if (executablePath) {
    return { executablePath, headless: true, args: ['--no-sandbox'] };
  }
  let chromium;
  try {
    chromium = require('@sparticuz/chromium');
  } catch (e) {
    throw new Error(
      'No Chrome/Edge/Chromium browser found on this machine, and the bundled headless-Chromium ' +
      'fallback (@sparticuz/chromium) is not installed. Install Google Chrome or Microsoft Edge, set ' +
      'the PDF_CHROME_PATH environment variable to your browser executable, or run "npm install" so the ' +
      'bundled fallback is available, then try again.'
    );
  }
  return {
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    args: chromium.args,
  };
}
 
module.exports = { findBrowser, getLaunchOptions };
