/**
 * Opt-in bridge to the separately installed Obsidian Dev Probe plugin.
 *
 * HN never persists these events or enables capture itself. The probe sets a
 * marker on each Obsidian window it owns; without that marker this module
 * returns before allocating a CustomEvent. Keep payloads small and emit only
 * lifecycle phases, never pointer-move samples.
 */
export const HN_DEV_PROBE_ACTIVE_KEY = "__obsidianDevProbeActive";
export const HN_DEV_PROBE_EVENT = "hn-dev-probe:diagnostic";

declare global {
  interface Window {
    __obsidianDevProbeActive?: boolean;
  }
}

export type HnDevProbeMetric = string | number | boolean | null;

export interface HnDevProbeDiagnostic {
  version: 1;
  source: "handwriting-natively";
  type:
    | "zoom-burst-start"
    | "zoom-settled"
    | "host-page-content-mutation"
    | "zoom-repaint"
    | "zoom-composite-release"
    | "sidecar-persist"
    | "manual-save";
  /** Stable local document identifier; the vault path is deliberately omitted. */
  documentId: string;
  at: number;
  metrics: Record<string, HnDevProbeMetric>;
}

export function isHnDevProbeActive(view: Window | null): view is Window {
  return view?.__obsidianDevProbeActive === true;
}

export function emitHnDevProbeDiagnostic(view: Window, diagnostic: HnDevProbeDiagnostic): void {
  view.dispatchEvent(new CustomEvent<HnDevProbeDiagnostic>(HN_DEV_PROBE_EVENT, { detail: diagnostic }));
}
