import {
  appearanceMappingVersionSchema,
  geneAppearance,
  markGlyph,
  type AppearanceMarks,
  type ChannelView,
  type MarkGlyph,
  type MarkHost,
} from '@ripple/contracts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import styles from './Creature.module.css';

type Organism = NonNullable<ChannelView['organism']>;
const tones: Readonly<Record<MarkGlyph['tone'], string>> = {
  teal: '#56d6c5',
  amber: '#f0bd68',
  coral: '#ef957f',
  moss: '#b1c997',
};

function Glyph({ host, x, origin }: { host: MarkHost; x: number; origin: boolean }) {
  const { shape, tone } = markGlyph(host.channelId),
    color = tones[tone],
    y = 945,
    stroke = { stroke: color, strokeWidth: 10, fill: 'none', strokeLinecap: 'round' as const };
  return (
    <g data-mark={origin ? 'origin' : 'ancestry'} data-shape={shape}>
      <title>{`${origin ? 'Origin' : 'Ancestry'} mark: ${host.label}`}</title>
      <circle
        cx={x}
        cy={y}
        r={origin ? 46 : 40}
        fill="#101820"
        stroke={origin ? '#edf5f4' : '#a7bcc4'}
        strokeWidth={origin ? 6 : 3}
      />
      {shape === 'ring' && <circle cx={x} cy={y} r="20" {...stroke} />}
      {shape === 'chevron' && (
        <path d={`M ${x - 22} ${y - 10} L ${x} ${y + 14} L ${x + 22} ${y - 10}`} {...stroke} />
      )}
      {shape === 'triad' &&
        [
          [0, -16],
          [-15, 11],
          [15, 11],
        ].map(([dx = 0, dy = 0]) => (
          <circle key={`${dx}-${dy}`} cx={x + dx} cy={y + dy} r="8" fill={color} />
        ))}
      {shape === 'bar' && <path d={`M ${x - 22} ${y} L ${x + 22} ${y}`} {...stroke} />}
      {shape === 'diamond' && (
        <path
          d={`M ${x} ${y - 22} L ${x + 20} ${y} L ${x} ${y + 22} L ${x - 20} ${y} Z`}
          {...stroke}
        />
      )}
      {shape === 'wave' && (
        <path d={`M ${x - 24} ${y} Q ${x - 12} ${y - 18} ${x} ${y} T ${x + 24} ${y}`} {...stroke} />
      )}
    </g>
  );
}

export function markSummary(marks: AppearanceMarks): string {
  return marks.ancestry.length === 0
    ? `Origin mark: ${marks.origin.label}`
    : `Origin mark: ${marks.origin.label}; ancestry marks: ${marks.ancestry.map((host) => host.label).join(', ')}`;
}

/**
 * Draws a committed organism. The persisted appearance mapping selects gene-linked parts; an
 * older retained update without one renders only the saved shell rather than guessing parts.
 */
export function Creature({ organism }: { organism: Organism }) {
  const design =
      organism.appearance.kind === 'studio' ? organism.appearance.blueprint : organism.appearance,
    mapping =
      organism.appearanceMapping === undefined
        ? undefined
        : appearanceMappingVersionSchema.safeParse(organism.appearanceMapping);
  if (mapping !== undefined && !mapping.success)
    return (
      <p role="alert">This appearance mapping version is unsupported. Its record is unchanged.</p>
    );
  const parts = mapping === undefined ? undefined : geneAppearance(organism.genome, mapping.data),
    marks = organism.marks,
    positions =
      marks === undefined
        ? []
        : [marks.origin, ...marks.ancestry].map(
            (_, index, all) => 500 + (index - (all.length - 1) / 2) * 120,
          ),
    description = [
      organism.name,
      parts === undefined
        ? undefined
        : `${parts.movement} movement, ${parts.plating} plating, ${parts.appendages}`,
      marks === undefined ? undefined : markSummary(marks),
    ]
      .filter((item) => item !== undefined)
      .join('. ');
  return (
    <div
      className={styles.creature}
      data-movement={organism.status === 'FOSSIL' ? 'still' : (parts?.movement ?? 'still')}
    >
      <ShellRenderer
        part={design.part}
        rendererVersion={design.rendererVersion}
        {...(parts === undefined ? {} : { parts })}
        label={description}
      >
        {marks !== undefined &&
          [marks.origin, ...marks.ancestry].map((host, index) => (
            <Glyph
              key={host.channelId}
              host={host}
              x={positions[index] ?? 500}
              origin={index === 0}
            />
          ))}
      </ShellRenderer>
    </div>
  );
}
