import { useState } from 'react';
import {
  defaultDisplayPreferences,
  type ChannelControl,
  type ChannelView,
  type DisplayPreferences,
} from '@ripple/contracts';
import styles from './Controller.module.css';

/** Presentation choices for the OBS overlay. They never change game state or history. */
export function DisplayControls({
  channel,
  version,
  disabled,
  control,
}: {
  channel: ChannelView;
  version: number;
  disabled: boolean;
  control: (body: ChannelControl) => void;
}) {
  const saved = channel.display ?? defaultDisplayPreferences,
    [draft, setDraft] = useState<DisplayPreferences | null>(null),
    current = draft ?? saved,
    changed =
      current.layout !== saved.layout ||
      current.reducedMotion !== saved.reducedMotion ||
      current.familyNews !== saved.familyNews ||
      current.celebrations !== saved.celebrations;
  return (
    <section className={styles.panel} aria-label="Overlay display">
      <h2>Overlay display</h2>
      <fieldset className={styles.choices}>
        <legend>Layout</legend>
        {(['compact', 'expanded'] as const).map((layout) => (
          <label key={layout} className={styles.inline}>
            <input
              type="radio"
              name="overlay-layout"
              checked={current.layout === layout}
              onChange={() => {
                setDraft({ ...current, layout });
              }}
            />
            {layout === 'compact' ? 'Compact lower corner' : 'Expanded · larger creature and text'}
          </label>
        ))}
      </fieldset>
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={current.reducedMotion}
          onChange={(event) => {
            setDraft({ ...current, reducedMotion: event.target.checked });
          }}
        />
        Reduce motion · keep the creature still
      </label>
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={current.familyNews}
          onChange={(event) => {
            setDraft({ ...current, familyNews: event.target.checked });
          }}
        />
        Show family news on the overlay between ballots
      </label>
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={current.celebrations}
          onChange={(event) => {
            setDraft({ ...current, celebrations: event.target.checked });
          }}
        />
        Show optional paid-event celebrations · never affect the game
      </label>
      <div className={styles.actions}>
        <button
          disabled={disabled || !changed}
          onClick={() => {
            control({ action: 'display', preferences: current, expectedVersion: version });
          }}
        >
          Save display preferences
        </button>
      </div>
      <p>
        {saved.layout === 'compact' ? 'Compact' : 'Expanded'} layout ·{' '}
        {saved.reducedMotion ? 'motion reduced' : 'subtle motion'} · family news{' '}
        {saved.familyNews ? 'shown' : 'hidden'} · celebrations{' '}
        {saved.celebrations ? 'shown' : 'hidden'} on the overlay. Viewers who ask their browser for
        reduced motion always get a still creature. Ripple plays no sound.
      </p>
    </section>
  );
}
