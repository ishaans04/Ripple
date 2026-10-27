import type { ShellParameters } from '@ripple/contracts';
import type { EditorChange } from './editor.ts';
import {
  pointToParameter,
  shellGeometry,
  type EditorPoint,
  type ShellParameter,
} from './shellGeometry.ts';

export interface HandPoint {
  readonly x: number;
  readonly y: number;
}
export interface TrackedHand {
  readonly landmarks: readonly HandPoint[];
  readonly confidence: number;
}
export interface GestureSettings {
  readonly oneHand: boolean;
  readonly sensitivity: number;
}
export interface GestureState {
  readonly point: EditorPoint | null;
  readonly key: ShellParameter | null;
  readonly frames: number;
  readonly scale: {
    readonly distance: number;
    readonly width: number;
    readonly height: number;
  } | null;
}
export const initialGestureState: GestureState = { point: null, key: null, frames: 0, scale: null };
export type GestureStatus = 'tracking_lost' | 'ready' | 'pinching' | 'scaling';
export interface GestureResult {
  readonly state: GestureState;
  readonly changes: readonly EditorChange[];
  readonly status: GestureStatus;
}
const distance = (a: EditorPoint, b: EditorPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function valid(hand: TrackedHand): boolean {
  return (
    hand.confidence >= 0.7 &&
    hand.landmarks.length === 21 &&
    hand.landmarks.every(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= 1 &&
        point.y >= 0 &&
        point.y <= 1,
    )
  );
}
function pointAt(hand: TrackedHand, index: number): HandPoint {
  const point = hand.landmarks[index];
  if (point === undefined) throw new RangeError('Missing validated hand landmark');
  return point;
}
function tip(hand: TrackedHand): EditorPoint {
  const point = pointAt(hand, 8);
  return { x: (1 - point.x) * 1000, y: point.y * 1000 };
}
function pinchRatio(hand: TrackedHand): number {
  return (
    distance(pointAt(hand, 4), pointAt(hand, 8)) /
    Math.max(0.05, distance(pointAt(hand, 0), pointAt(hand, 9)))
  );
}

/** Browser-local interpretation only. Its action vocabulary cannot submit or change genes. */
export function interpretHands(
  previous: GestureState,
  hands: readonly TrackedHand[],
  parameters: ShellParameters,
  settings: GestureSettings,
): GestureResult {
  const first = hands[0];
  if (first === undefined || !valid(first))
    return { state: initialGestureState, changes: [], status: 'tracking_lost' };
  const frames = previous.frames + 1;
  if (frames < 3)
    return { state: { ...initialGestureState, frames }, changes: [], status: 'ready' };
  const second = settings.oneHand ? undefined : hands[1];
  if (
    second !== undefined &&
    valid(second) &&
    pinchRatio(first) < 0.4 &&
    pinchRatio(second) < 0.4
  ) {
    const separation = distance(tip(first), tip(second));
    if (separation < 80)
      return { state: { ...initialGestureState, frames }, changes: [], status: 'ready' };
    const scale = previous.scale ?? {
      distance: separation,
      width: parameters.width,
      height: parameters.height,
    };
    const factor =
      1 + (separation / scale.distance - 1) * Math.min(1.5, Math.max(0.5, settings.sensitivity));
    return {
      state: { point: null, key: null, frames, scale },
      status: 'scaling',
      changes: [
        { type: 'parameter', key: 'width', value: Math.round(scale.width * factor) },
        { type: 'parameter', key: 'height', value: Math.round(scale.height * factor) },
      ],
    };
  }
  const raw = tip(first);
  const smoothed =
    previous.point === null || distance(previous.point, raw) < 2
      ? raw
      : {
          x: previous.point.x + (raw.x - previous.point.x) * 0.4,
          y: previous.point.y + (raw.y - previous.point.y) * 0.4,
        };
  const pinching = pinchRatio(first) < (previous.key === null ? 0.35 : 0.55);
  if (!pinching)
    return {
      state: { point: smoothed, key: null, frames, scale: null },
      changes: [],
      status: 'ready',
    };
  let key = previous.key;
  if (key === null) {
    const handles = shellGeometry(parameters).handles;
    const closest = (Object.keys(handles) as ShellParameter[]).sort(
      (a, b) => distance(handles[a], smoothed) - distance(handles[b], smoothed),
    )[0];
    if (closest !== undefined && distance(handles[closest], smoothed) <= 125) key = closest;
  }
  if (key === null)
    return { state: { point: smoothed, key, frames, scale: null }, changes: [], status: 'ready' };
  const target = pointToParameter(key, smoothed, parameters);
  const value =
    parameters[key] +
    (target - parameters[key]) * Math.min(1.5, Math.max(0.5, settings.sensitivity));
  return {
    state: { point: smoothed, key, frames, scale: null },
    changes: [{ type: 'parameter', key, value }],
    status: 'pinching',
  };
}
