import type { SttSessionConfig } from '@soniox/client';
import type { CaptionLanguage } from '../types';

export type CaptionPace = 'responsive' | 'context';
export type TranslationMode = 'auto' | 'en_to_ja' | 'ja_to_en';

export function fallbackTranslationLanguage(mode: TranslationMode): CaptionLanguage | null {
  return mode === 'auto' ? null : mode === 'ja_to_en' ? 'en' : 'ja';
}

// Soniox's documented low-latency starting point. These control semantic
// finalization, not a guaranteed translation interval or a word-by-word timer.
// https://soniox.com/docs/stt/rt/endpoint-detection
export function speechConfig(defaults: Partial<SttSessionConfig> | undefined, pace: CaptionPace, mode: TranslationMode = 'en_to_ja'): SttSessionConfig {
  const model = defaults?.model ?? 'stt-rt-v5';
  const endpoints = model === 'stt-rt-v5' ? pace === 'responsive' ? {
    endpoint_latency_adjustment_level: 2,
    endpoint_sensitivity: 0.3,
    max_endpoint_delay_ms: 1500,
  } : {
    endpoint_latency_adjustment_level: 0,
    endpoint_sensitivity: 0,
    max_endpoint_delay_ms: 2000,
  } : {};
  return {
    ...defaults,
    model,
    // Both hints let Japanese speech contain English terms without restarting
    // the session or using spelling to guess the translation direction.
    language_hints: ['en', 'ja'],
    language_hints_strict: false,
    enable_language_identification: true,
    translation: mode === 'auto'
      ? { type: 'two_way', language_a: 'en', language_b: 'ja' }
      : { type: 'one_way', target_language: mode === 'ja_to_en' ? 'en' : 'ja' },
    enable_endpoint_detection: true,
    ...endpoints,
  };
}
