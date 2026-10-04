export type CaptionStatus = 'idle' | 'connecting' | 'live' | 'rehearsal' | 'reconnecting' | 'error' | 'stopped' | 'stopping';
export interface Captions {
  english: string;
  japanese: string;
  partialEnglish: string;
  partialJapanese: string;
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
  english: string;
  japanese: string;
  partialJapanese?: string;
  status: 'idle' | 'live' | 'rehearsal' | 'reconnecting' | 'error' | 'stopped';
}
declare global {
  interface Window {
    stageDesktop?: {
      isDesktop: true;
      getDisplays(): Promise<Display[]>;
      openOverlay(options: OverlayOptions): Promise<void>;
      updateOverlay(payload: OverlayPayload): void;
      closeOverlay(): Promise<void>;
      onOverlayClosed(callback: () => void): () => void;
    };
  }
}
