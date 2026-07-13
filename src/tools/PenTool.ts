import type { DrawingToolPreferences, PdfPoint } from "../model";

export function penSampleWidth(preferences: DrawingToolPreferences, point: PdfPoint): number {
  const pressure = preferences.pressureSensitivity ? Math.max(0.15, point.pressure) : 0.5;
  return preferences.width * (1 - preferences.thinning + preferences.thinning * pressure * 2);
}

