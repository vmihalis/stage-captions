import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SonioxClient } from '@soniox/client';
import type { AudioSource, Recording } from '@soniox/client';
import { fallbackTranslationLanguage, speechConfig } from '../../src/lib/speech-config.ts';
import type { CaptionPace, TranslationMode } from '../../src/lib/speech-config.ts';
import { accumulate, emptyCaptions } from '../../src/lib/captions.ts';
import { advanceAudienceCaptions, emptyAudienceCaptions, expireAudienceCaptions } from '../../src/lib/audience-captions.ts';
import { toOverlayPayload } from '../../src/lib/caption-output.ts';

// Exercise the real installed SDK's configuration whitelist and message parser.
// The transport is entirely in memory: no provider, credentials, or microphone.
class WireFixture extends EventTarget {
  static instances: WireFixture[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer';
  sent: unknown[] = [];
  constructor(url: string) {
    super();
    assert.equal(url, 'wss://soniox.invalid/stage-fixture');
    WireFixture.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(data: unknown) { this.sent.push(data); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  result(tokens: unknown[]) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ tokens,
      total_audio_proc_ms: 1000, final_audio_proc_ms: 500 }) }));
  }
}

async function connect(pace: CaptionPace, mode: TranslationMode = 'en_to_ja', model = 'stt-rt-v5') {
  let stopped = false;
  const source: AudioSource = {
    async start(handlers) { handlers.onData(new Uint8Array(1920).buffer); },
    stop() { stopped = true; },
  };
  const client = new SonioxClient({ config: async () => ({ api_key: 'fixture-only',
    stt_ws_url: 'wss://soniox.invalid/stage-fixture',
    stt_defaults: { model, context: { terms: ['Stage'] } } }) });
  const recording = client.realtime.record({ model, source, auto_reconnect: false,
    session_config: resolved => speechConfig(resolved.stt_defaults, pace, mode) });
  await new Promise<void>((resolve, reject) => { recording.on('connected', resolve); recording.on('error', reject); });
  const wire = WireFixture.instances.at(-1)!;
  const config = JSON.parse(wire.sent.find(data => typeof data === 'string') as string);
  return { recording, wire, config, sourceStopped: () => stopped };
}

test('language modes and caption pace reach the real SDK wire config', { timeout: 5000 }, async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WireFixture as unknown as typeof WebSocket;
  const recordings: Recording[] = [];
  try {
    const fast = await connect('responsive');
    recordings.push(fast.recording);
    assert.equal(fast.config.endpoint_latency_adjustment_level, 2);
    assert.equal(fast.config.endpoint_sensitivity, 0.3);
    assert.equal(fast.config.max_endpoint_delay_ms, 1500);
    assert.equal(fast.config.enable_endpoint_detection, true);
    assert.deepEqual(fast.config.translation, { type: 'one_way', target_language: 'ja' });
    assert.deepEqual(fast.config.context, { terms: ['Stage'] });
    assert.deepEqual(fast.config.language_hints, ['en', 'ja']);
    assert.equal(fast.config.language_hints_strict, false);
    assert.equal(fast.config.enable_language_identification, true);
    assert.equal(fallbackTranslationLanguage('en_to_ja'), 'ja');
    fast.recording.cancel();
    assert.equal(fast.sourceStopped(), true);

    const reverse = await connect('responsive', 'ja_to_en');
    recordings.push(reverse.recording);
    assert.deepEqual(reverse.config.translation, { type: 'one_way', target_language: 'en' });
    assert.deepEqual(reverse.config.language_hints, ['en', 'ja']);
    assert.equal(reverse.config.enable_language_identification, true);
    assert.equal(fallbackTranslationLanguage('ja_to_en'), 'en');

    const auto = await connect('responsive', 'auto');
    recordings.push(auto.recording);
    assert.deepEqual(auto.config.translation, { type: 'two_way', language_a: 'en', language_b: 'ja' });
    assert.deepEqual(auto.config.language_hints, ['en', 'ja']);
    assert.equal(auto.config.language_hints_strict, false);
    assert.equal(auto.config.enable_language_identification, true);
    assert.equal(fallbackTranslationLanguage('auto'), null);

    const context = await connect('context');
    recordings.push(context.recording);
    assert.equal(context.config.endpoint_latency_adjustment_level, 0);
    assert.equal(context.config.endpoint_sensitivity, 0);
    assert.equal(context.config.max_endpoint_delay_ms, 2000);
    const legacy = await connect('responsive', 'en_to_ja', 'stt-rt-v4');
    recordings.push(legacy.recording);
    assert.equal('endpoint_latency_adjustment_level' in legacy.config, false,
      'Older models must not receive v5-only parameters.');
    assert.equal('endpoint_sensitivity' in legacy.config, false);
  } finally {
    recordings.forEach(recording => recording.cancel());
    globalThis.WebSocket = original;
  }
});

test('one SDK recording streams both directions, preserves mixed-language source, and expires only the audience', { timeout: 5000 }, async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WireFixture as unknown as typeof WebSocket;
  let recording: Recording | undefined;
  try {
    const connectionsBefore = WireFixture.instances.length;
    const live = await connect('responsive', 'auto');
    recording = live.recording;
    let presenter = emptyCaptions();
    let audience = emptyAudienceCaptions();
    let now = 0;
    let events = 0;
    let parsedSourceLanguage: string | undefined;
    recording.on('result', result => {
      presenter = accumulate(presenter, result.tokens, null);
      audience = advanceAudienceCaptions(audience, result.tokens, now, null);
      parsedSourceLanguage = result.tokens.find(token => token.translation_status === 'translation')?.source_language;
      events++;
    });
    const translated = (text: string, language: 'ja' | 'en', is_final = false) => ({
      text, language, is_final, translation_status: 'translation',
      source_language: language === 'ja' ? 'en' : 'ja',
    });

    live.wire.result([{ text: 'Thank you for joining us today.', is_final: true,
      translation_status: 'original', language: 'en' }, translated('本日は', 'ja')]);
    assert.equal(events, 1);
    assert.equal(parsedSourceLanguage, 'en', 'The installed SDK must preserve translation source metadata.');
    assert.equal(presenter.source, 'Thank you for joining us today.');
    assert.equal(audience.captions.partialTranslation, '本日は');
    assert.equal(audience.captions.translation, '');
    assert.equal(audience.captions.translationLanguage, 'ja');

    now = 200;
    live.wire.result([translated('本日はご参加いただき', 'ja')]);
    assert.equal(events, 2, 'Each draft is delivered without waiting for an endpoint.');
    assert.equal(audience.captions.partialTranslation, '本日はご参加いただき');
    now = 300;
    live.wire.result([{ text: '<end>', is_final: true }]);
    assert.equal(presenter.partialTranslation, '本日はご参加いただき');
    assert.equal(audience.lastActivityAt, 200, 'SDK-filtered control frames must not prolong old text.');
    now = 400;
    live.wire.result([translated('本日はご参加いただき、ありがとうございます。', 'ja', true)]);
    assert.equal(audience.captions.partialTranslation, '');
    assert.equal(audience.captions.translation, '本日はご参加いただき、ありがとうございます。');

    // These are provider-shaped fixtures, not a claim that recognition always
    // preserves English names this way. The app must preserve whatever arrives.
    now = 500;
    const mixedJapanese = 'このAPIはGitHubで公開しています。';
    live.wire.result([{ text: mixedJapanese, is_final: true,
      translation_status: 'original', language: 'ja' }]);
    assert.ok(presenter.source.endsWith(mixedJapanese));
    assert.ok(audience.captions.source.endsWith(mixedJapanese));
    now = 600;
    live.wire.result([translated('This API is public', 'en')]);
    assert.equal(parsedSourceLanguage, 'ja');
    assert.equal(audience.captions.translationLanguage, 'en');
    assert.equal(audience.captions.translation, '', 'The new language must not retain the previous Japanese caption.');
    assert.equal(audience.captions.partialTranslation, 'This API is public');
    const draftOverlay = toOverlayPayload(audience.captions, 'live');
    assert.equal(draftOverlay.partialJapanese, 'This API is public',
      'English translations belong to the primary caption fields, so hiding the optional source row cannot hide them.');
    assert.equal(draftOverlay.translationLanguage, 'en');

    now = 800;
    live.wire.result([translated('This API is available on GitHub.', 'en')]);
    assert.equal(audience.captions.partialTranslation, 'This API is available on GitHub.');
    const acceptedAudience = audience;
    const acceptedPresenter = presenter;
    now = 900;
    live.wire.result([{ text: 'Bonjour', is_final: false, translation_status: 'translation',
      language: 'fr', source_language: 'ja' }]);
    assert.deepEqual(presenter, acceptedPresenter, 'Unsupported target metadata must not erase a valid draft.');
    assert.deepEqual(audience, acceptedAudience);
    now = 1000;
    live.wire.result([{ text: 'Unknown target', is_final: false, translation_status: 'translation', source_language: 'ja' }]);
    assert.deepEqual(presenter, acceptedPresenter, 'Auto mode must not guess a missing target language.');
    assert.deepEqual(audience, acceptedAudience);
    now = 1100;
    live.wire.result([]);
    assert.equal(presenter.partialTranslation, 'This API is available on GitHub.');
    assert.equal(audience.lastActivityAt, 800);

    now = 1200;
    live.wire.result([translated('This API is available on GitHub.', 'en', true)]);
    assert.equal(audience.captions.partialTranslation, '');
    assert.equal(audience.captions.translation, 'This API is available on GitHub.');
    assert.equal(presenter.translation, audience.captions.translation);
    const overlay = toOverlayPayload(audience.captions, 'live');
    assert.equal(overlay.japanese, 'This API is available on GitHub.');
    assert.equal(overlay.partialJapanese, '');
    assert.equal(overlay.translationLanguage, 'en');
    assert.ok(overlay.english.endsWith(mixedJapanese), 'The compatibility source field must retain the actual Japanese source.');
    now = 1500;
    live.wire.result([{ text: '<fin>', is_final: true }]);
    assert.equal(audience.lastActivityAt, 1200);
    audience = expireAudienceCaptions(audience, 7200);
    assert.equal(audience.captions.translation, '');
    assert.equal(audience.captions.partialTranslation, '');
    assert.equal(presenter.translation, 'This API is available on GitHub.');
    assert.equal(live.sourceStopped(), false, 'Audience expiry must not cancel the recording.');

    now = 8000;
    live.wire.result([{ text: 'Next slide.', is_final: true, translation_status: 'original', language: 'en' }]);
    assert.equal(audience.captions.translation, '', 'New source speech must not resurrect expired translated text.');
    now = 8500;
    live.wire.result([translated('次のスライドです。', 'ja', true)]);
    assert.equal(audience.captions.translationLanguage, 'ja');
    assert.equal(audience.captions.translation, '次のスライドです。');
    assert.equal(expireAudienceCaptions(audience, 14499).captions.translation, '次のスライドです。');
    assert.equal(expireAudienceCaptions(audience, 14500).captions.translation, '');
    assert.equal(WireFixture.instances.length, connectionsBefore + 1,
      'Changing spoken language must use the existing session, without opening another socket.');
  } finally {
    recording?.cancel();
    globalThis.WebSocket = original;
  }
});
