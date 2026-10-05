const fs = require('node:fs/promises');
const path = require('node:path');

const KEYS = ['STAGE_SUMMARY_WORKER', 'STAGE_SUMMARY_RUNTIME', 'STAGE_SUMMARY_MODEL'];
// Owner-created settings survive Finder launches and replacing Stage.app. Only
// executable paths/model selection live here; authentication remains with OMP.
async function summaryEnvironment(userData, environment = process.env) {
  try {
    const file = path.join(userData, 'summary-worker.json');
    if ((await fs.stat(file)).size > 4096) return environment;
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || Object.keys(settings).some(key => !KEYS.includes(key))
      || Object.values(settings).some(value => typeof value !== 'string' || value.length > 2048)) return environment;
    const result = { ...environment };
    for (const key of KEYS) if (!result[key] && settings[key]) result[key] = settings[key];
    return result;
  } catch { return environment; }
}
module.exports = { summaryEnvironment };
