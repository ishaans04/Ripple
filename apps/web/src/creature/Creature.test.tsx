import { renderToStaticMarkup } from 'react-dom/server';
import { founderShell, type ChannelView } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { Creature, markSummary } from './Creature.tsx';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';

type Organism = NonNullable<ChannelView['organism']>;
const host = (n: number, label: string) => ({
  channelId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  label,
});
const organism: Organism = {
  id: '00000000-0000-4000-8000-000000000100',
  name: 'Mira strain',
  health: 42,
  status: 'ALIVE',
  genome: { pulse: 10, calm: 2, grit: 11, drift: 1 },
  appearance: { kind: 'founder', rendererVersion: 'shell-v1', part: founderShell },
  appearanceMapping: 1,
  marks: {
    origin: host(1, 'Origin <b>channel</b>'),
    ancestry: [host(2, 'Second'), host(3, 'Third')],
  },
};
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

describe('creature appearance', () => {
  it('draws the persisted mapping parts, movement and every mark with text alternatives', () => {
    const markup = renderToStaticMarkup(<Creature organism={organism} />);
    expect(markup).toContain('data-movement="quick"');
    expect(markup).toContain('data-appendages="stubs"');
    expect(markup).toContain('data-plating="armored"');
    expect(count(markup, /data-plate=""/g)).toBe(5);
    expect(count(markup, /data-mark="origin"/g)).toBe(1);
    expect(count(markup, /data-mark="ancestry"/g)).toBe(2);
    expect(markup).toContain('Origin mark: Origin &lt;b&gt;channel&lt;/b&gt;');
    expect(markup).toContain('quick movement, armored plating, stubs');
    expect(markup).not.toMatch(/<b>|<script|<foreignObject|<image/);
  });
  it('holds fossils still and keeps their saved parts', () => {
    const markup = renderToStaticMarkup(<Creature organism={{ ...organism, status: 'FOSSIL' }} />);
    expect(markup).toContain('data-movement="still"');
    expect(markup).toContain('data-appendages="stubs"');
  });
  it('renders only the saved shell for retained updates that predate the mapping', () => {
    const older: Organism = {
        id: organism.id,
        name: organism.name,
        health: organism.health,
        status: organism.status,
        genome: organism.genome,
        appearance: organism.appearance,
      },
      markup = renderToStaticMarkup(<Creature organism={older} />);
    expect(markup).toContain('data-renderer="shell-v1"');
    expect(markup).toContain('data-movement="still"');
    expect(markup).not.toContain('data-appendages');
    expect(markup).not.toContain('data-mark');
  });
  it('refuses an unknown mapping version instead of guessing parts', () => {
    const markup = renderToStaticMarkup(
      <Creature organism={{ ...organism, appearanceMapping: 2 as 1 }} />,
    );
    expect(markup).toContain('unsupported');
    expect(markup).not.toContain('<svg');
  });
  it('summarizes marks in reading order', () => {
    expect(markSummary(organism.marks!)).toBe(
      'Origin mark: Origin <b>channel</b>; ancestry marks: Second, Third',
    );
    expect(markSummary({ origin: host(1, 'Home'), ancestry: [] })).toBe('Origin mark: Home');
  });
  it('keeps the studio editor drawing unchanged when no gene parts are supplied', () => {
    const markup = renderToStaticMarkup(<ShellRenderer part={founderShell} />);
    expect(markup).toContain('M 345 700 Q 280 870 230 800 M 655 700 Q 720 870 770 800');
    expect(markup).not.toContain('data-plate');
    expect(markup).not.toContain('data-appendages');
  });
});
