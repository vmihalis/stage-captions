import type { OverlayOptions } from '../types';
import type { CaptionPace, TranslationMode } from './speech-config';

export type ControllerPreferences = { deviceId: string; pace: CaptionPace; mode: TranslationMode; displayMode: 'readable' | 'drafts'; options: OverlayOptions };
const key = 'stage-controller-preferences-v1';

// Only presentation preferences cross launches. Team codes, keys, and session
// state are never written here. Validate local storage just like any other input.
export function parseControllerPreferences(value: unknown, desktop: boolean): ControllerPreferences {
  const defaults: ControllerPreferences = { deviceId: 'default', pace: 'responsive', mode: 'auto', displayMode: 'readable', options: { outputMode: desktop ? 'overlay' : 'window', fontSize: 42, position: 'bottom', showEnglish: false, opacity: .9, clickThrough: true } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const input = value as Record<string, unknown>;
  const options = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options as Record<string, unknown> : {};
  return {
    deviceId: typeof input.deviceId === 'string' && input.deviceId.length <= 512 ? input.deviceId : defaults.deviceId,
    pace: input.pace === 'context' ? 'context' : defaults.pace,
    mode: input.mode === 'en_to_ja' || input.mode === 'ja_to_en' ? input.mode : defaults.mode,
    displayMode: input.displayMode === 'drafts' ? 'drafts' : defaults.displayMode,
    options: {
      outputMode: desktop && ['overlay', 'window', 'presentation'].includes(String(options.outputMode)) ? options.outputMode as OverlayOptions['outputMode'] : defaults.options.outputMode,
      displayId: typeof options.displayId === 'string' && options.displayId.length <= 256 ? options.displayId : undefined,
      fontSize: Number.isInteger(options.fontSize) && Number(options.fontSize) >= 24 && Number(options.fontSize) <= 96 ? Number(options.fontSize) : 42,
      position: options.position === 'top' ? 'top' : 'bottom', showEnglish: options.showEnglish === true,
      opacity: typeof options.opacity === 'number' && Number.isFinite(options.opacity) && options.opacity >= .4 && options.opacity <= 1 ? options.opacity : .9,
      clickThrough: true,
    },
  };
}
export function readControllerPreferences(): ControllerPreferences {
  try { return parseControllerPreferences(JSON.parse(localStorage.getItem(key) ?? 'null'), !!window.stageDesktop); }
  catch { return parseControllerPreferences(null, !!window.stageDesktop); }
}
export function saveControllerPreferences(value: ControllerPreferences) {
  try { localStorage.setItem(key, JSON.stringify(parseControllerPreferences(value, !!window.stageDesktop))); }
  catch { /* Private browsing may not allow preference storage. */ }
}
