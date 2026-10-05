export type CaptionStatus = 'idle' | 'connecting' | 'live' | 'rehearsal' | 'reconnecting' | 'error' | 'stopped' | 'stopping';
export type CaptionLanguage = 'en' | 'ja';
export interface Captions {
  source: string;
  translation: string;
  partialSource: string;
  partialTranslation: string;
  translationLanguage: CaptionLanguage;
  stableLines?: string[];
  displayLagMs?: number;
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
  outputMode?: 'overlay' | 'window' | 'presentation';
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
  stableLines?: string[];
  translationLanguage?: CaptionLanguage;
  status: 'idle' | 'live' | 'rehearsal' | 'reconnecting' | 'error' | 'stopped';
}
export interface OverlayState {
  open: boolean; visible: boolean; shortcutRegistered: boolean;
  outputMode?: 'overlay' | 'window' | 'presentation';
  presentationStatus?: 'choosing' | 'sharing' | 'error' | null;
  presentationError?: string;
}
export interface MeetingSummary {
  overview: { text: string; evidenceEntryIds: string[] }[];
  decisions: { text: string; evidenceEntryIds: string[] }[];
  actions: { text: string; assignee: string | null; dueDate: string | null; evidenceEntryIds: string[] }[];
  openQuestions: { text: string; evidenceEntryIds: string[] }[];
}
export type SummaryResult = { ok: true; summary: MeetingSummary } | { ok: false; error: { code: string; message: string; recoverable: true } };
export type ControllerAction = 'settings' | 'output' | 'toggle-recording' | 'end-meeting';
export type WorkspaceView = 'meetings' | 'vocabulary' | 'setup';
declare global {
  interface Window {
    stageDesktop?: {
      isDesktop: true;
      getCapabilities?(): Promise<{ apiVersion: number; outputModes: string[]; stableLines: boolean; saveMeetingExport?: boolean; summaryWorker?: boolean; compactController?: boolean; controllerShortcutRegistered?: boolean }>;
      setControllerLayout?(layout: { height: number }): Promise<void>;
      hideController?(): Promise<void>;
      updateControllerState?(state: { status: CaptionStatus; paused: boolean; pending: number }): void;
      onControllerAction?(callback: (action: ControllerAction) => void): () => void;
      openWorkspace?(view: WorkspaceView, meetingId?: string): Promise<void>;
      saveMeetingExport?(data: { filename: string; text: string; format: 'json' | 'md' }): Promise<{ saved: boolean }>;
      cancelSummary?(): Promise<void>;
      summarizeMeeting?(data: import('./lib/meetings').MeetingExport): Promise<SummaryResult>;
      getDisplays(): Promise<Display[]>;
      openOverlay(options: OverlayOptions): Promise<void>;
      updateOverlay(payload: OverlayPayload): void;
      closeOverlay(): Promise<void>;
      toggleOverlay?(): Promise<void>;
      onOverlayClosed(callback: () => void): () => void;
      configureOverlay?(options: OverlayOptions): Promise<void>;
      getOverlayState?(): Promise<OverlayState>;
      onOverlayStateChanged?(callback: (state: OverlayState) => void): () => void;
    };
  }
}
