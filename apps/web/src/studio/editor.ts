import { founderShell, shellBounds, shellPartSchema, type ShellPart } from '@ripple/contracts';
import type { ShellParameter } from './shellGeometry.ts';

export type EditorChange =
  | { readonly type: 'parameter'; readonly key: ShellParameter; readonly value: number }
  | { readonly type: 'marking'; readonly pattern: ShellPart['marking']['patternId'] }
  | { readonly type: 'palette'; readonly palette: ShellPart['marking']['paletteId'] };

export interface EditorState {
  readonly part: ShellPart;
  readonly past: readonly ShellPart[];
  readonly future: readonly ShellPart[];
  readonly gestureStart: ShellPart | null;
}
export type EditorAction =
  | EditorChange
  | { readonly type: 'undo' | 'redo' | 'reset' | 'begin' | 'end' }
  | { readonly type: 'restore'; readonly part: ShellPart };
export function initialEditor(part: ShellPart = founderShell): EditorState {
  return { part: shellPartSchema.parse(part), past: [], future: [], gestureStart: null };
}
const same = (a: ShellPart, b: ShellPart) => JSON.stringify(a) === JSON.stringify(b);
export function changeShell(part: ShellPart, change: EditorChange): ShellPart {
  let next: ShellPart;
  switch (change.type) {
    case 'parameter': {
      if (!Number.isFinite(change.value)) return part;
      const bounds = shellBounds[change.key];
      const value = Math.min(bounds.max, Math.max(bounds.min, Math.round(change.value)));
      next = { ...part, parameters: { ...part.parameters, [change.key]: value } };
      break;
    }
    case 'marking':
      next = { ...part, marking: { ...part.marking, patternId: change.pattern } };
      break;
    case 'palette':
      next = { ...part, marking: { ...part.marking, paletteId: change.palette } };
      break;
  }
  return shellPartSchema.parse(next);
}
function record(state: EditorState, part: ShellPart): EditorState {
  if (same(state.part, part)) return state;
  return {
    part,
    past: state.gestureStart === null ? [...state.past, state.part].slice(-100) : state.past,
    future: [],
    gestureStart: state.gestureStart,
  };
}
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'begin':
      return state.gestureStart === null ? { ...state, gestureStart: state.part } : state;
    case 'end':
      return {
        ...state,
        past:
          state.gestureStart !== null && !same(state.gestureStart, state.part)
            ? [...state.past, state.gestureStart].slice(-100)
            : state.past,
        gestureStart: null,
      };
    case 'undo': {
      const previous = state.past.at(-1);
      return previous === undefined
        ? state
        : {
            part: previous,
            past: state.past.slice(0, -1),
            future: [state.part, ...state.future].slice(0, 100),
            gestureStart: null,
          };
    }
    case 'redo': {
      const next = state.future[0];
      return next === undefined
        ? state
        : {
            part: next,
            past: [...state.past, state.part].slice(-100),
            future: state.future.slice(1),
            gestureStart: null,
          };
    }
    case 'reset':
      return record(state, founderShell);
    case 'restore':
      return initialEditor(action.part);
    case 'parameter':
    case 'marking':
    case 'palette':
      return record(state, changeShell(state.part, action));
  }
}
