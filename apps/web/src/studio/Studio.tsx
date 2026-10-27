import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  founderShell,
  markingPatterns,
  shellBounds,
  shellPalettes,
  type AppearanceBlueprint,
  type StudioMutationTemplate,
} from '@ripple/contracts';
import {
  acceptBlueprint,
  candidateRuleset,
  createStudioChallenge,
  studioMutationMove,
} from '@ripple/engine';
import { editorReducer, initialEditor } from './editor.ts';
import { loadDraft, saveDraft } from './drafts.ts';
import { EditorCanvas } from './EditorCanvas.tsx';
import { HandControls } from './HandControls.tsx';
import styles from './Studio.module.css';

// An explicitly local practice context, never an impersonated live studio or world.
export const practiceChallenge = createStudioChallenge(
  {
    worldId: '00000000-0000-4000-8000-000000000001',
    studioSessionId: '00000000-0000-4000-8000-000000000002',
    baseOrganismId: '00000000-0000-4000-8000-000000000003',
    baseOrganismVersion: 0,
    genome: candidateRuleset.genome.founder,
    baseAppearanceHash: null,
    targetMutationSlot: 1,
  },
  candidateRuleset,
);
const templateNames: Record<StudioMutationTemplate, string> = {
  'grit-plus2-pulse-minus2': 'Grit +2 · Pulse −2',
  'grit-plus2-calm-minus2': 'Grit +2 · Calm −2',
  'grit-plus2-drift-minus2': 'Grit +2 · Drift −2',
  'cosmetic-only': 'Appearance only · genes unchanged',
};

function recover() {
  try {
    return loadDraft(localStorage, practiceChallenge, Date.now());
  } catch {
    return null;
  }
}
export default function Studio() {
  const [recovered] = useState(recover);
  const [state, dispatch] = useReducer(
    editorReducer,
    recovered?.part ?? founderShell,
    initialEditor,
  );
  const [template, setTemplate] = useState<StudioMutationTemplate>(
    recovered?.mutationTemplateId ?? 'grit-plus2-pulse-minus2',
  );
  const [confirming, setConfirming] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (confirming && dialog.current?.open === false) dialog.current.showModal();
    if (!confirming) dialog.current?.close();
  }, [confirming]);
  const [saveStatus, setSaveStatus] = useState('Your draft stays on this device.');
  const blueprint: AppearanceBlueprint = useMemo(
    () => ({
      schemaVersion: 1,
      worldId: practiceChallenge.worldId,
      studioSessionId: practiceChallenge.studioSessionId,
      baseOrganismId: practiceChallenge.baseOrganismId,
      baseOrganismVersion: practiceChallenge.baseOrganismVersion,
      rendererVersion: 'shell-v1',
      mutationTemplateId: template,
      part: state.part,
    }),
    [state.part, template],
  );
  useEffect(() => {
    const timer = setTimeout(() => {
      let saved = false;
      try {
        saved = saveDraft(localStorage, blueprint, practiceChallenge, Date.now());
      } catch {
        /* Download remains available. */
      }
      setSaveStatus(
        saved
          ? 'Draft saved on this device.'
          : 'Device storage is unavailable. Download your design to keep it.',
      );
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [blueprint]);
  function download() {
    const accepted = acceptBlueprint(blueprint, practiceChallenge, candidateRuleset);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ blueprint: accepted.blueprint, hash: accepted.hash }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `ripple-shell-${accepted.hash.slice(0, 8)}.json`;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    setConfirming(false);
    setSaveStatus('Design downloaded. Your local draft is also kept.');
  }
  const move = studioMutationMove(template);
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a href="/" className={styles.brand}>
          Ripple<span> / Cocoon Studio</span>
        </a>
        <span className={styles.badge}>Local practice</span>
      </header>
      <section className={styles.intro}>
        <p className={styles.eyebrow}>A little shell. A lasting story.</p>
        <h1>Shape what travels next.</h1>
        <p>Pull a point. Find a pattern. Give this strain a shell of its own.</p>
        <p className={styles.muted}>
          Explore at your own pace. This practice design stays on your device and does not change a
          live game.
        </p>
      </section>
      <div className={styles.workspace}>
        <section className={styles.preview} aria-label="Shell editor">
          <div className={styles.previewTop}>
            <span>YOUR SHELL</span>
            <span>Drag a point to sculpt</span>
          </div>
          <EditorCanvas part={state.part} dispatch={dispatch} />
          <div className={styles.toolbar}>
            <button
              onClick={() => {
                dispatch({ type: 'undo' });
              }}
              disabled={state.past.length === 0}
            >
              Undo
            </button>
            <button
              onClick={() => {
                dispatch({ type: 'redo' });
              }}
              disabled={state.future.length === 0}
            >
              Redo
            </button>
            <button
              onClick={() => {
                dispatch({ type: 'reset' });
              }}
            >
              Reset shell
            </button>
          </div>
          <p className={styles.hint}>
            Mouse, touch, or keyboard. Focus a point and use arrow keys; hold Shift for fine
            adjustments.
          </p>
        </section>
        <aside className={styles.controls}>
          <HandControls part={state.part} dispatch={dispatch} />
          <section>
            <p className={styles.eyebrow}>01 / The trade-off</p>
            <h2>Reinforce the shell</h2>
            <label htmlFor="trade-off">Choose its genetic cost</label>
            <select
              id="trade-off"
              value={template}
              onChange={(event) => {
                const selected = practiceChallenge.mutationTemplateIds.find(
                  (id) => id === event.target.value,
                );
                if (selected !== undefined) setTemplate(selected);
              }}
            >
              {practiceChallenge.mutationTemplateIds.map((id) => (
                <option key={id} value={id}>
                  {templateNames[id]}
                </option>
              ))}
            </select>
            <p className={styles.muted}>
              {move === null
                ? 'This design is cosmetic. It changes no genes or fitness.'
                : `A stronger shell gives up a little ${move.from === 'pulse' ? 'burst affinity' : move.from === 'calm' ? 'steadiness' : 'travel reserve'}. Its size and decoration add no extra power.`}
            </p>
          </section>
          <section>
            <p className={styles.eyebrow}>02 / The shape</p>
            <h2>Make it yours</h2>
            {(['width', 'height', 'curvature'] as const).map((key) => (
              <label key={key} className={styles.rangeLabel}>
                <span>
                  {key.charAt(0).toUpperCase() + key.slice(1)}
                  <output>{state.part.parameters[key]}</output>
                </span>
                <input
                  type="range"
                  aria-label={`Shell ${key}`}
                  min={shellBounds[key].min}
                  max={shellBounds[key].max}
                  value={state.part.parameters[key]}
                  onChange={(event) => {
                    dispatch({ type: 'parameter', key, value: Number(event.target.value) });
                  }}
                />
              </label>
            ))}
          </section>
          <section>
            <p className={styles.eyebrow}>03 / The signature</p>
            <fieldset>
              <legend>Marking</legend>
              <div className={styles.options}>
                {markingPatterns.map((pattern) => (
                  <button
                    key={pattern}
                    aria-pressed={state.part.marking.patternId === pattern}
                    onClick={() => {
                      dispatch({ type: 'marking', pattern });
                    }}
                  >
                    {pattern}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Palette</legend>
              <div className={styles.options}>
                {shellPalettes.map((palette) => (
                  <button
                    key={palette}
                    className={styles.palette}
                    data-palette={palette}
                    aria-pressed={state.part.marking.paletteId === palette}
                    onClick={() => {
                      dispatch({ type: 'palette', palette });
                    }}
                  >
                    {palette.replace('-', ' + ')}
                  </button>
                ))}
              </div>
            </fieldset>
          </section>
          <button
            className={styles.primary}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Save design <span aria-hidden="true">↗</span>
          </button>
          <p className={styles.muted} role="status">
            {saveStatus}
          </p>
        </aside>
      </div>
      <footer className={styles.footer}>
        <span>Created here. Carried onward.</span>
        <span>Local practice · no live proposal is submitted</span>
      </footer>
      <dialog
        ref={dialog}
        className={styles.dialog}
        onCancel={() => {
          setConfirming(false);
        }}
        aria-labelledby="save-title"
      >
        <h2 id="save-title">Save this shell?</h2>
        <p>
          Download your design and its genetic trade-off. This saves a local design, not a live
          proposal.
        </p>
        <button className={styles.primary} autoFocus onClick={download}>
          Download design
        </button>
        <button
          onClick={() => {
            setConfirming(false);
          }}
        >
          Keep editing
        </button>
      </dialog>
    </main>
  );
}
