import assert from 'node:assert/strict';
import test from 'node:test';
import { parseControllerPreferences } from '../../src/lib/controller-preferences';

test('controller preferences retain only bounded presentation settings', () => {
  const prefs = parseControllerPreferences({ deviceId: 'presenter', mode: 'ja_to_en', pace: 'context', displayMode: 'drafts', teamCode: 'never-store-this', options: { outputMode: 'presentation', fontSize: 64, opacity: .7, position: 'top', showEnglish: true, displayId: 'projector', secret: 'never-store-this' } }, true);
  assert.equal(prefs.mode, 'ja_to_en');
  assert.equal(prefs.options.fontSize, 64);
  assert.equal(prefs.options.outputMode, 'presentation');
  assert.equal(prefs.deviceId, 'presenter');
  assert.ok(!JSON.stringify(prefs).includes('never-store-this'));
  assert.equal(parseControllerPreferences(prefs, false).options.outputMode, 'window');
});

test('invalid stored settings cannot make captions unusable', () => {
  for (const input of [null, [], false, 'bad']) assert.equal(parseControllerPreferences(input, true).options.fontSize, 42);
  const prefs = parseControllerPreferences({ deviceId: 'x'.repeat(513), pace: 'bad', mode: 'bad', displayMode: 'bad', options: { fontSize: 9999, opacity: NaN, position: 'left', outputMode: 'bad', displayId: 'x'.repeat(257), showEnglish: 'yes' } }, true);
  assert.equal(prefs.deviceId, 'default');
  assert.equal(prefs.options.fontSize, 42);
  assert.equal(prefs.options.opacity, .9);
  assert.equal(prefs.options.outputMode, 'overlay');
  assert.equal(prefs.options.position, 'bottom');
  assert.equal(prefs.options.displayId, undefined);
  assert.equal(prefs.options.showEnglish, false);
});
