// Development-only preview. Keeps the installed Stage app and its profile separate.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
app.setName('Stage Preview');
app.setPath('userData', path.join(root, 'work', 'desktop-preview'));
process.env.STAGE_SERVER_URL = 'http://127.0.0.1:4318';
const configuration = path.join(root, 'work', 'summary-runtime', 'preview-config.json');
if (fs.existsSync(configuration)) {
  const settings = JSON.parse(fs.readFileSync(configuration, 'utf8'));
  for (const key of ['STAGE_SUMMARY_WORKER', 'STAGE_SUMMARY_RUNTIME', 'STAGE_SUMMARY_MODEL']) {
    if (typeof settings[key] === 'string') process.env[key] = settings[key];
  }
}
require('../electron/main.cjs');
