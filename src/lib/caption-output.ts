import { captionTail, captionWindow } from './captions';
import type { Captions, CaptionStatus, OverlayPayload } from '../types';

export function toOverlayPayload(captions: Captions, status: CaptionStatus): OverlayPayload {
  const visible = captions.stableLines ? { final: captions.stableLines.join("\n"), partial: "" } : captionWindow(captions.translation, captions.partialTranslation,
    captions.translationLanguage === 'en' ? 180 : 90);
  // Installed desktop shells use these field names for the source and primary
  // caption slots. English translations must use the primary slot too.
  return {
    english: captionTail(captions.source + captions.partialSource, 180),
    japanese: visible.final,
    partialJapanese: visible.partial,
    ...(captions.stableLines ? { stableLines: captions.stableLines } : {}),
    translationLanguage: captions.translationLanguage,
    status: status === 'connecting' ? 'idle' : status === 'stopping' ? 'stopped' : status,
  };
}
