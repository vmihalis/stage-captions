import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SonioxClient } from '@soniox/client';
import type { AudioSource, AudioSourceHandlers, Recording } from '@soniox/client';

// Use the installed SDK's pause/reconnect behavior with an in-memory transport.
// No microphone, credentials, or external connection is involved.
class PauseWire extends EventTarget {
  static instances: PauseWire[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: unknown[] = [];
  constructor(url: string) {
    super();
    assert.equal(url, 'wss://soniox.invalid/pause-fixture');
    PauseWire.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(data: unknown) {
    this.sent.push(data);
    if (data === '') queueMicrotask(() => this.result([], true));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  result(tokens: unknown[], finished = false) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ tokens, finished,
      total_audio_proc_ms: 1000, final_audio_proc_ms: 1000 }) }));
  }
  audio() { return this.sent.filter(data => data instanceof Uint8Array).map(data => Array.from(data as Uint8Array)); }
}

class PauseSource implements AudioSource {
  handlers!: AudioSourceHandlers;
  capturing = false;
  pauseCount = 0;
  resumeCount = 0;
  stopCount = 0;
  async start(handlers: AudioSourceHandlers) { this.handlers = handlers; this.capturing = true; }
  pause() { this.pauseCount++; this.capturing = false; }
  resume() { this.resumeCount++; this.capturing = true; }
  stop() { this.stopCount++; this.capturing = false; }
  restart() { this.capturing = true; }
  speak(value: number) { if (this.capturing) this.handlers.onData(new Uint8Array([value]).buffer); }
}

async function fixture(run: (recording: Recording, source: PauseSource, wire: PauseWire) => Promise<void>) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = PauseWire as unknown as typeof WebSocket;
  const source = new PauseSource();
  let recording: Recording | undefined;
  try {
    const client = new SonioxClient({ config: {
      api_key: 'fixture-only', stt_ws_url: 'wss://soniox.invalid/pause-fixture',
    } });
    recording = client.realtime.record({ model: 'stt-rt-v5', source,
      auto_reconnect: true, max_reconnect_attempts: 1, reconnect_base_delay_ms: 1 });
    await new Promise<void>((resolve, reject) => { recording!.once('connected', resolve); recording!.once('error', reject); });
    await run(recording, source, PauseWire.instances.at(-1)!);
  } finally {
    recording?.cancel();
    globalThis.WebSocket = original;
  }
}

test('pause retains the session, finalizes earlier speech, and never replays paused speech', { timeout: 5000 }, async () => {
  await fixture(async (recording, source, wire) => {
    const connections = PauseWire.instances.length;
    const terminal: string[] = [];
    let results = 0;
    recording.on('state_change', ({ new_state }) => {
      if (['stopped', 'canceled', 'error'].includes(new_state)) terminal.push(new_state);
    });
    recording.on('result', () => { results++; });
    source.speak(1);
    recording.pause();
    recording.pause();
    assert.equal(recording.state, 'paused');
    assert.equal(source.capturing, false);
    assert.equal(source.pauseCount, 1);
    assert.equal(wire.sent.includes('{"type":"finalize"}'), true);
    source.speak(2);
    // A late callback from already captured audio must not bypass SDK pause.
    source.handlers.onData(new Uint8Array([3]).buffer);
    wire.result([{ text: 'Earlier speech.', is_final: true, language: 'en' }]);
    assert.equal(results, 1, 'Previously sent speech may finish while paused.');
    assert.deepEqual(wire.audio(), [[1]]);
    recording.resume();
    recording.resume();
    source.speak(4);
    assert.equal(recording.state, 'recording');
    assert.equal(source.resumeCount, 1);
    assert.equal(PauseWire.instances.length, connections);
    assert.deepEqual(wire.audio(), [[1], [4]]);
    assert.deepEqual(terminal, []);
    assert.equal(source.stopCount, 0);
  });
});

test('a paused recording remains paused after network reconnection', { timeout: 5000 }, async () => {
  await fixture(async (recording, source, wire) => {
    source.speak(1);
    recording.pause();
    const reconnected = new Promise<void>((resolve, reject) => {
      recording.once('reconnected', () => resolve()); recording.once('error', reject);
    });
    recording.reconnect();
    source.speak(2);
    await reconnected;
    const replacement = PauseWire.instances.at(-1)!;
    assert.notEqual(replacement, wire);
    assert.equal(recording.state, 'paused');
    assert.equal(source.capturing, false);
    source.speak(3);
    assert.deepEqual(replacement.audio(), []);
    recording.resume();
    source.speak(4);
    assert.deepEqual(replacement.audio(), [[4]]);
  });
});

test('external microphone unmute cannot override an intentional pause', { timeout: 5000 }, async () => {
  await fixture(async (recording, source, wire) => {
    recording.pause();
    source.handlers.onMuted?.();
    source.handlers.onUnmuted?.();
    source.speak(1);
    assert.equal(recording.state, 'paused');
    assert.equal(source.capturing, false);
    assert.deepEqual(wire.audio(), []);
    source.handlers.onMuted?.();
    recording.resume();
    source.speak(2);
    assert.deepEqual(wire.audio(), [], 'Resume must still respect a hardware/OS mute.');
    source.handlers.onUnmuted?.();
    source.speak(3);
    assert.deepEqual(wire.audio(), [[3]]);
  });
});

test('Stop and a source failure still terminate a paused recording', { timeout: 5000 }, async () => {
  await fixture(async (recording, source) => {
    recording.pause();
    await recording.stop();
    assert.equal(recording.state, 'stopped');
    assert.equal(source.capturing, false);
    recording.resume();
    assert.equal(source.capturing, false);
  });
  await fixture(async (recording, source) => {
    let errors = 0;
    recording.on('error', () => { errors++; });
    recording.pause();
    source.handlers.onError(new Error('Fixture microphone disconnected'));
    assert.equal(recording.state, 'error');
    assert.equal(source.capturing, false);
    assert.equal(errors, 1);
    recording.resume();
    assert.equal(source.capturing, false);
  });
});
