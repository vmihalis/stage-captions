import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopRecording } from '../../src/lib/stop-recording.ts';

test('pending provider/microphone startup cannot leave Stop waiting forever', async () => {
  let cancelled = false;
  const result = await stopRecording({ stop: () => new Promise(() => {}), cancel: () => { cancelled = true; } }, 5);
  assert.equal(cancelled, true);
  assert.equal(result.interrupted, true);
});
test('normal stop allows finalized results before cancellation', async () => {
  const events: string[] = [];
  const result = await stopRecording({ stop: async () => { events.push('final text'); }, cancel: () => { events.push('cancel'); } }, 20);
  assert.deepEqual(events, ['final text', 'cancel']);
  assert.equal(result.interrupted, false);
});
