import type { SttSessionConfig } from '@soniox/client';

export type CaptionPace = 'responsive' | 'context';

// Soniox's documented low-latency starting point. These control semantic
// finalization, not a guaranteed translation interval or a word-by-word timer.
// https://soniox.com/docs/stt/rt/endpoint-detection
export function speechConfig(defaults: Partial<SttSessionConfig> | undefined, pace: CaptionPace): SttSessionConfig {
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
    language_hints: ['en'],
    translation: { type: 'one_way', target_language: 'ja' },
    enable_endpoint_detection: true,
    ...endpoints,
  };
}
