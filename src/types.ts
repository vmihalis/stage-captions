export type CaptionStatus = 'idle' | 'connecting' | 'live' | 'rehearsal' | 'reconnecting' | 'error' | 'stopped' | 'stopping';
export type CaptionLanguage = 'en' | 'ja';
export interface Captions {
  source: string;
  translation: string;
  partialSource: string;
  partialTranslation: string;
  translationLanguage: CaptionLanguage;
}
export interface Glossary {
  terms: string[];
  translationTerms: { source: string; target: string }[];
  background: string;
}
export interface Team { name: string; glossary: Glossary }
export interface Session {
  authenticated: boolean;
  team: { name: string };
  provider: { configured: boolean; region: string };
}
export interface Display { id: string; label: string; width: number; height: number; primary: boolean }
export interface OverlayOptions {
  displayId?: string;
  fontSize: number;
  position: 'bottom' | 'top';
  showEnglish: boolean;
  opacity: number;
  clickThrough: boolean;
}
export interface OverlayPayload {
  // Compatibility names for installed desktop shells: spoken text and
  // primary translation, regardless of the languages used in the session.
  english: string;
  japanese: string;
  partialJapanese?: string;
  translationLanguage?: CaptionLanguage;
  status: 'idle' | 'live' | 'rehearsal' | 'reconnecting' | 'error' | 'stopped';
}
export interface OverlayState { open: boolean; visible: boolean; shortcutRegistered: boolean }
declare global {
  interface Window {
    stageDesktop?: {
      isDesktop: true;
      getDisplays(): Promise<Display[]>;
      openOverlay(options: OverlayOptions): Promise<void>;
      updateOverlay(payload: OverlayPayload): void;
      closeOverlay(): Promise<void>;
      onOverlayClosed(callback: () => void): () => void;
      configureOverlay?(options: OverlayOptions): Promise<void>;
      getOverlayState?(): Promise<OverlayState>;
      onOverlayStateChanged?(callback: (state: OverlayState) => void): () => void;
    };
  }
}
