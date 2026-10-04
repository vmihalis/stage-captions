import { HttpError } from './errors.mjs';

export const SONIOX_MODEL = 'stt-rt-v5';
export const REGIONS = Object.freeze({
  global: { api: 'https://api.soniox.com', websocket: 'wss://stt-rt.soniox.com/transcribe-websocket' },
  eu: { api: 'https://api.eu.soniox.com', websocket: 'wss://stt-rt.eu.soniox.com/transcribe-websocket' },
  jp: { api: 'https://api.jp.soniox.com', websocket: 'wss://stt-rt.jp.soniox.com/transcribe-websocket' },
});

// Audio travels directly from the presenter's client to Soniox. This service
// issues a one-stream credential; it never receives audio or transcript data.
export function createSonioxProvider({ apiKey = '', region = 'global', fetchImpl = fetch } = {}) {
  if (!Object.hasOwn(REGIONS, region)) throw new Error('Unsupported Soniox region.');
  const endpoints = REGIONS[region];
  return {
    configured: Boolean(apiKey),
    region,
    async issue(referenceId) {
      if (!apiKey) throw new HttpError(503, 'Live translation is not configured. Ask your team administrator to add a Soniox API key.');
      let response;
      try {
        response = await fetchImpl(`${endpoints.api}/v1/auth/temporary-api-key`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            usage_type: 'transcribe_websocket',
            expires_in_seconds: 60,
            single_use: true,
            max_session_duration_seconds: 18000,
            client_reference_id: String(referenceId).slice(0, 256),
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new HttpError(502, 'The translation service could not be reached. Please try again.');
      }
      if (!response.ok) {
        if (response.status === 429) throw new HttpError(503, 'The translation service is at capacity. Please try again shortly.');
        // Provider error payloads can contain diagnostics or credentials. Do not
        // relay them to a client or write them to an application log.
        throw new HttpError(502, 'The translation service could not start a session. Ask your administrator to check the API key, permissions, and region.');
      }
      let payload;
      try { payload = await response.json(); } catch {
        throw new HttpError(502, 'The translation service returned an invalid response.');
      }
      if (typeof payload?.api_key !== 'string' || payload.api_key.length < 8 || payload.api_key.length > 8192 || payload.api_key === apiKey) {
        throw new HttpError(502, 'The translation service returned an invalid credential.');
      }
      return { apiKey: payload.api_key, websocketUrl: endpoints.websocket, model: SONIOX_MODEL };
    },
  };
}

export function glossaryToContext(glossary) {
  const context = {};
  if (glossary.background) context.text = glossary.background;
  if (glossary.terms.length) context.terms = glossary.terms;
  if (glossary.translationTerms.length) {
    context.translation_terms = glossary.translationTerms.map(({ source, target }) => ({ source, target }));
  }
  return context;
}
