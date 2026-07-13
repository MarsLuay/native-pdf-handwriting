import type { DrawingToolPreferences, PdfPoint } from "../model";

export interface PencilSample { width: number; opacity: number; textureStrength: number }

export function pencilSample(preferences: DrawingToolPreferences, point: PdfPoint): PencilSample {
  const pressure = preferences.pressureSensitivity ? Math.max(0.1, point.pressure) : 0.5;
  const tilt = preferences.tiltSensitivity ? Math.min(1, (Math.abs(point.tiltX ?? 0) + Math.abs(point.tiltY ?? 0)) / 120) : 0;
  return {
    width: preferences.width * (0.65 + pressure * 0.7 + tilt * 0.35),
    opacity: Math.min(1, preferences.opacity * (0.35 + pressure * 0.65)),
    textureStrength: preferences.textureStrength
  };
}

