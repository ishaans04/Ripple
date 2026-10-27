import { founderShell } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { changeShell } from './editor.ts';
import { initialGestureState, interpretHands, type TrackedHand } from './gestures.ts';

function hand(x: number, y: number, pinching = true): TrackedHand {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.2, y: 0.5 }));
  landmarks[0] = { x: 0.2, y: 0.8 };
  landmarks[8] = { x: 1 - x / 1000, y: y / 1000 };
  landmarks[4] = { x: landmarks[8].x + (pinching ? 0.02 : 0.2), y: y / 1000 };
  return { landmarks, confidence: 0.99 };
}
describe('hand-to-editor interpretation', () => {
  it('produces the same bounded shell as pointer input without any submission action', () => {
    let gesture = initialGestureState;
    let part = founderShell;
    for (const x of [...Array<number>(5).fill(810), ...Array<number>(30).fill(990)]) {
      const result = interpretHands(gesture, [hand(x, 500)], part.parameters, {
        oneHand: true,
        sensitivity: 1,
      });
      gesture = result.state;
      for (const change of result.changes) part = changeShell(part, change);
    }
    expect(part).toEqual(
      changeShell(founderShell, { type: 'parameter', key: 'width', value: 980 }),
    );
    expect(part.parameters.width).toBe(850);
  });
  it('freezes on loss, low confidence, malformed landmarks, and ambiguous gestures', () => {
    const acquired = interpretHands(
      { ...initialGestureState, frames: 3 },
      [hand(810, 500)],
      founderShell.parameters,
      { oneHand: true, sensitivity: 1 },
    );
    for (const hands of [
      [],
      [{ ...hand(810, 500), confidence: 0.2 }],
      [{ ...hand(810, 500), landmarks: [] }],
    ]) {
      const lost = interpretHands(acquired.state, hands, founderShell.parameters, {
        oneHand: true,
        sensitivity: 1,
      });
      expect(lost.changes).toEqual([]);
      expect(lost.status).toBe('tracking_lost');
      expect(lost.state.key).toBeNull();
    }
    expect(
      interpretHands(acquired.state, [hand(810, 500, false)], founderShell.parameters, {
        oneHand: true,
        sensitivity: 1,
      }).changes,
    ).toEqual([]);
  });
  it('scales both dimensions using two pinches and preserves one-hand mode', () => {
    const start = interpretHands(
      { ...initialGestureState, frames: 3 },
      [hand(250, 500), hand(750, 500)],
      founderShell.parameters,
      { oneHand: false, sensitivity: 1 },
    );
    const scaled = interpretHands(
      start.state,
      [hand(150, 500), hand(850, 500)],
      founderShell.parameters,
      { oneHand: false, sensitivity: 1 },
    );
    expect(scaled.status).toBe('scaling');
    expect(scaled.changes).toHaveLength(2);
    expect(
      interpretHands(start.state, [hand(150, 500), hand(850, 500)], founderShell.parameters, {
        oneHand: true,
        sensitivity: 1,
      }).status,
    ).not.toBe('scaling');
  });
});
