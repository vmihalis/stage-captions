import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { createSonioxProvider, glossaryToContext } from './soniox.mjs';
import { createCodeVerifier, createRateLimiter, digest, readSessionToken } from './security.mjs';
import { validateTeamPatch } from './validation.mjs';
import { HttpError } from './errors.mjs';
import { registerMeetingRoutes } from './meetings.mjs';

const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;

export function createApp({ config: configOverrides = {}, provider, store } = {}) {
  const config = { ...loadConfig(), ...configOverrides };
  if (typeof config.teamAccessCode !== 'string' || config.teamAccessCode.length < 12 || config.teamAccessCode.length > 256) {
    throw new Error('A team access code of 12–256 characters is required.');
  }
  const database = store || createStore(config.databasePath);
  const speech = provider || createSonioxProvider({ apiKey: config.sonioxApiKey, region: config.sonioxRegion });
  const verifier = createCodeVerifier(config.teamAccessCode, database.salt);
  database.activateCodeVersion(verifier.version);
  const loginLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
  const speechLimiter = createRateLimiter({ limit: 12, windowMs: 60_000 });
  const teamSpeechLimiter = createRateLimiter({ limit: config.teamTokenLimitPerMinute, windowMs: 60_000 });
  const app = express();
  app.disable('x-powered-by');
  // Trust only explicitly configured proxy addresses. The ingress must replace
  // client-supplied forwarding headers before forwarding requests to Stage.
  app.set('trust proxy', config.trustedProxyIps.length ? config.trustedProxyIps : false);
  app.locals.store = database;

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'microphone=(self), camera=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://stt-rt.soniox.com wss://stt-rt.eu.soniox.com wss://stt-rt.jp.soniox.com; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (config.publicOrigin.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if ((origin && origin !== config.publicOrigin) || (unsafe && origin !== config.publicOrigin)) {
      return next(new HttpError(403, 'Request origin is not allowed. Open Stage using its configured address.'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '48kb' }));
  app.use('/api', (req, res, next) => {
    const token = readSessionToken(req);
    req.stageSession = token ? database.findSession(digest(token), verifier.version) : null;
    next();
  });

  const sessionState = (req) => ({
    authenticated: Boolean(req.stageSession),
    team: { name: database.getTeam().name },
    provider: { configured: Boolean(speech.configured), region: speech.region },
  });
  const requireSession = (req, res, next) => req.stageSession ? next() : next(new HttpError(401, 'Enter your team access code to continue.'));
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.publicOrigin.startsWith('https:'), path: '/' };

  app.get('/api/session', (req, res) => res.json(sessionState(req)));
  app.post('/api/auth/unlock', async (req, res) => {
    const key = req.ip || 'unknown';
    if (!loginLimiter.take(key)) {
      res.set('Retry-After', '900');
      throw new HttpError(429, 'Too many incorrect access attempts. Try again in 15 minutes.');
    }
    const code = req.body?.code;
    if (typeof code !== 'string' || code.length < 1 || code.length > 256) throw new HttpError(400, 'Enter a valid team access code.');
    if (!(await verifier.verify(code))) throw new HttpError(401, 'That team access code is not correct.');
    loginLimiter.reset(key);
    const oldToken = readSessionToken(req);
    if (oldToken) database.deleteSession(digest(oldToken));
    const token = randomBytes(32).toString('base64url');
    req.stageSession = database.createSession(digest(token), verifier.version, Date.now() + SESSION_AGE);
    res.cookie('stage_session', token, { ...cookieOptions, maxAge: SESSION_AGE });
    res.json(sessionState(req));
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = readSessionToken(req);
    if (token) database.deleteSession(digest(token));
    res.clearCookie('stage_session', cookieOptions);
    res.json({ ok: true });
  });
  app.get('/api/team', requireSession, (req, res) => res.json(database.getTeam()));
  app.patch('/api/team', requireSession, (req, res) => {
    const team = validateTeamPatch(req.body, database.getTeam());
    database.updateTeam(team);
    res.json(team);
  });
  app.post('/api/speech/token', requireSession, async (req, res) => {
    if (!speechLimiter.take(req.stageSession.id)) {
      res.set('Retry-After', '60');
      throw new HttpError(429, 'Too many session starts. Wait a minute and try again.');
    }
    // This bounds issuance attempts across sessions in this process. Audio goes
    // directly to Soniox, so this is not a spending or active-stream limit.
    if (!teamSpeechLimiter.take('team')) {
      res.set('Retry-After', '60');
      throw new HttpError(429, 'The team has started too many sessions. Wait a minute and try again.');
    }
    const issued = await speech.issue(req.stageSession.id);
    // Only this allowlist leaves the server; keep the provider's master key,
    // diagnostics, and unrelated payload fields out of client responses.
    if (typeof issued.apiKey !== 'string' || issued.apiKey === config.sonioxApiKey) throw new HttpError(502, 'The translation service returned an invalid credential.');
    res.json({
      apiKey: issued.apiKey, websocketUrl: issued.websocketUrl, model: issued.model,
      context: glossaryToContext(database.getTeam().glossary),
    });
  });
  registerMeetingRoutes(app, database.meetings, requireSession);
  app.use('/api', (req, res, next) => next(new HttpError(404, 'This API endpoint does not exist.')));

  if (existsSync(join(config.distPath, 'index.html'))) {
    app.use(express.static(config.distPath, { index: false }));
    app.get('/{*path}', (req, res) => res.sendFile(join(config.distPath, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Provide valid JSON.' });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}
