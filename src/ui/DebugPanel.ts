export interface DebugState {
  pointerType?: string;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  page?: number;
  pdfX?: number;
  pdfY?: number;
  scale?: number;
  rotation?: number;
  tool?: string;
  dropdown?: string | null;
  dirty?: boolean;
  autosave?: boolean;
  lastSavedAt?: string;
  pending?: boolean;
}
