import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SonioxClient } from '@soniox/client';
import type { AudioSource, Recording } from '@soniox/client';
import { speechConfig } from '../../src/lib/speech-config.ts';
import type { CaptionPace } from '../../src/lib/speech-config.ts';
import { accumulate, emptyCaptions } from '../../src/lib/captions.ts';
import { advanceAudienceCaptions, emptyAudienceCaptions, expireAudienceCaptions } from '../../src/lib/audience-captions.ts';

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

async function connect(pace: CaptionPace, model = 'stt-rt-v5') {
  let stopped = false;
  const source: AudioSource = {
    async start(handlers) { handlers.onData(new Uint8Array(1920).buffer); },
    stop() { stopped = true; },
  };
  const client = new SonioxClient({ config: async () => ({ api_key: 'fixture-only',
    stt_ws_url: 'wss://soniox.invalid/stage-fixture',
    stt_defaults: { model, context: { terms: ['Stage'] } } }) });
  const recording = client.realtime.record({ model, source, auto_reconnect: false,
    session_config: resolved => speechConfig(resolved.stt_defaults, pace) });
  await new Promise<void>((resolve, reject) => { recording.on('connected', resolve); recording.on('error', reject); });
  const wire = WireFixture.instances.at(-1)!;
  const config = JSON.parse(wire.sent.find(data => typeof data === 'string') as string);
  return { recording, wire, config, sourceStopped: () => stopped };
}

test('caption pace reaches the real SDK wire config; drafts display before finalization', { timeout: 5000 }, async () => {
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
    assert.deepEqual(fast.config.language_hints, ['en']);
    let presenter = emptyCaptions();
    let audience = emptyAudienceCaptions();
    let now = 0;
    let events = 0;
    fast.recording.on('result', result => {
      presenter = accumulate(presenter, result.tokens);
      audience = advanceAudienceCaptions(audience, result.tokens, now);
      events++;
    });
    const ja = (text: string, is_final = false) => ({ text, is_final,
      translation_status: 'translation', language: 'ja' });
    fast.wire.result([ja('本日は')]);
    assert.equal(events, 1);
    assert.equal(audience.captions.partialJapanese, '本日は');
    assert.equal(audience.captions.japanese, '');
    now = 200;
    fast.wire.result([ja('本日はご参加いただき')]);
    assert.equal(events, 2, 'Each incoming draft must be delivered immediately, without waiting for an endpoint.');
    assert.equal(audience.captions.partialJapanese, '本日はご参加いただき');
    now = 300;
    fast.wire.result([{ text: '<end>', is_final: true }]);
    assert.equal(presenter.partialJapanese, '本日はご参加いただき');
    assert.equal(audience.lastActivityAt, 200, 'Control frames must not prolong old text.');
    now = 400;
    fast.wire.result([ja('本日はご参加いただき、ありがとうございます。', true)]);
    assert.equal(audience.captions.partialJapanese, '');
    assert.equal(audience.captions.japanese, '本日はご参加いただき、ありがとうございます。');
    assert.equal(presenter.japanese, audience.captions.japanese);
    assert.equal(expireAudienceCaptions(audience, 6400).captions.japanese, '');
    assert.equal(presenter.japanese, '本日はご参加いただき、ありがとうございます。');
    fast.recording.cancel();
    assert.equal(fast.sourceStopped(), true);

    const context = await connect('context');
    recordings.push(context.recording);
    assert.equal(context.config.endpoint_latency_adjustment_level, 0);
    assert.equal(context.config.endpoint_sensitivity, 0);
    assert.equal(context.config.max_endpoint_delay_ms, 2000);
    const legacy = await connect('responsive', 'stt-rt-v4');
    recordings.push(legacy.recording);
    assert.equal('endpoint_latency_adjustment_level' in legacy.config, false,
      'Older models must not receive v5-only parameters.');
    assert.equal('endpoint_sensitivity' in legacy.config, false);
  } finally {
    recordings.forEach(recording => recording.cancel());
    globalThis.WebSocket = original;
  }
});
