import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { resolveAccessCode } from './access-code.mjs';

const config = loadConfig();
const access = resolveAccessCode(config);
config.teamAccessCode = access.code;
const app = createApp({ config });
const server = app.listen(config.port, config.host, () => {
  console.log(`Stage is ready at ${config.publicOrigin}`);
  if (access.path) console.log(`Your local team access code is saved in ${access.path}`);
  if (!config.sonioxApiKey) console.log('Live translation is unavailable until SONIOX_API_KEY is configured. Demo mode is available.');
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => { app.locals.store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
