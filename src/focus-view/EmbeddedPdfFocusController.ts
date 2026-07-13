import type { ObsidianPdfAdapter, PdfViewState } from "../integration/ObsidianPdfAdapter";
import { FocusOverlay, type FocusOverlayOptions } from "./FocusOverlay";

export interface EmbeddedFocusOptions extends Omit<FocusOverlayOptions, "onClosed"> {
  source: ObsidianPdfAdapter;
  renderViewer: (container: HTMLElement, initialState: PdfViewState) => Promise<ObsidianPdfAdapter> | ObsidianPdfAdapter;
  onClosed?: () => void;
}

export class EmbeddedPdfFocusController {
  private overlay: FocusOverlay | null = null;
  private focusedAdapter: ObsidianPdfAdapter | null = null;

  constructor(private readonly options: EmbeddedFocusOptions) {}

  async open(): Promise<void> {
    if (this.overlay) return;
    const initialState = this.options.source.getViewState();
    this.overlay = new FocusOverlay({
      ...(this.options.document ? { document: this.options.document } : {}),
      ...(this.options.title ? { title: this.options.title } : {}),
      autosave: this.options.autosave,
      isDirty: this.options.isDirty,
      flush: this.options.flush,
      decideUnsaved: this.options.decideUnsaved,
      onClosed: () => {
        this.focusedAdapter?.destroy();
        this.focusedAdapter = null;
        this.overlay = null;
        this.options.onClosed?.();
      }
    });
    this.focusedAdapter = await this.options.renderViewer(this.overlay.content, initialState);
    this.focusedAdapter.restoreViewState(initialState);
  }

  async close(): Promise<boolean> {
    return this.overlay?.requestClose("close-button") ?? true;
  }

  destroy(): void {
    this.focusedAdapter?.destroy();
    this.focusedAdapter = null;
    this.overlay?.destroy();
    this.overlay = null;
  }
}
