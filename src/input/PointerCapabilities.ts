export type PointerKind = "pen" | "touch" | "mouse" | "unknown";

export interface PointerSample {
  pointerId: number;
  pointerType: PointerKind;
  clientX: number;
  clientY: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  altitudeAngle?: number;
  azimuthAngle?: number;
  width: number;
  height: number;
  buttons: number;
  timeStamp: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export class PointerCapabilities {
  static kind(event: Pick<PointerEvent, "pointerType">): PointerKind {
    return event.pointerType === "pen" || event.pointerType === "touch" || event.pointerType === "mouse"
      ? event.pointerType
      : "unknown";
  }

  static sample(event: PointerEvent): PointerSample {
    const source = event as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
    const sample: PointerSample = {
      pointerId: event.pointerId,
      pointerType: this.kind(event),
      clientX: event.clientX,
      clientY: event.clientY,
      pressure: finite(event.pressure, 0),
      tiltX: finite(event.tiltX, 0),
      tiltY: finite(event.tiltY, 0),
      width: finite(event.width, 1),
      height: finite(event.height, 1),
      buttons: finite(event.buttons, 0),
      timeStamp: finite(event.timeStamp, performance.now())
    };
    if (typeof source.altitudeAngle === "number") sample.altitudeAngle = source.altitudeAngle;
    if (typeof source.azimuthAngle === "number") sample.azimuthAngle = source.azimuthAngle;
    return sample;
  }

  static samples(event: PointerEvent): PointerSample[] {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    return (coalesced.length > 0 ? coalesced : [event]).map((sample) => this.sample(sample));
  }

  static hasTilt(event: PointerEvent): boolean {
    return event.tiltX !== 0 || event.tiltY !== 0 || "altitudeAngle" in event;
  }
}
