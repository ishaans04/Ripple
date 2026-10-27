import fc from 'fast-check';
import { founderShell, shellBounds, shellPartSchema } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { editorReducer, initialEditor } from './editor.ts';
import { shellGeometry } from './shellGeometry.ts';

describe('shared shell editor', () => {
  it('bounds and quantizes all input paths to the same valid geometry', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (value) => {
        for (const key of ['width', 'height', 'curvature'] as const) {
          const result = editorReducer(initialEditor(), { type: 'parameter', key, value });
          expect(shellPartSchema.safeParse(result.part).success).toBe(true);
          expect(result.part.parameters[key]).toBeGreaterThanOrEqual(shellBounds[key].min);
          expect(result.part.parameters[key]).toBeLessThanOrEqual(shellBounds[key].max);
        }
      }),
    );
  });
  it('undoes an entire drag once, supports redo, and resets without losing undo', () => {
    let state = editorReducer(initialEditor(), { type: 'begin' });
    for (const value of [700, 750, 800])
      state = editorReducer(state, { type: 'parameter', key: 'width', value });
    state = editorReducer(state, { type: 'end' });
    expect(state.past).toHaveLength(1);
    state = editorReducer(state, { type: 'undo' });
    expect(state.part).toEqual(founderShell);
    state = editorReducer(state, { type: 'redo' });
    expect(state.part.parameters.width).toBe(800);
    expect(editorReducer(state, { type: 'reset' }).part).toEqual(founderShell);
  });
  it('renders only finite, bounded geometry and rejects arbitrary SVG parameters', () => {
    expect(shellGeometry(founderShell.parameters).path).not.toMatch(/NaN|Infinity|script/);
    expect(() => shellGeometry({ width: 9999, height: 440, curvature: 300 })).toThrow();
  });
});
