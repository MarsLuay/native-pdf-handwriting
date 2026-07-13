export interface PdfSearchMatch { page: number; index: number; length: number }
export interface PdfTextSearchAdapter {
  search(query: string, options?: { caseSensitive?: boolean; wholeWords?: boolean }): Promise<readonly PdfSearchMatch[]>;
  select(match: PdfSearchMatch): Promise<void>;
  clear(): void;
}

