export interface PdfOutlineItem { title: string; destination: unknown; children: PdfOutlineItem[] }
export interface PdfOutlineAdapter { getOutline(): Promise<readonly PdfOutlineItem[]>; navigate(destination: unknown): Promise<void> }

