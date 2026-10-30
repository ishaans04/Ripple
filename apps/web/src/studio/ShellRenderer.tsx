import { useId, type ReactNode } from 'react';
import { shellPartSchema, type GeneAppearance, type ShellPart } from '@ripple/contracts';
import { shellGeometry } from './shellGeometry.ts';

const palettes = {
  'teal-amber': { fill: '#56d6c5', detail: '#f0bd68', edge: '#122e36' },
  'coral-ink': { fill: '#ef957f', detail: '#f6dba3', edge: '#302d43' },
  'moss-cream': { fill: '#b1c997', detail: '#f5eccf', edge: '#293c39' },
} as const;

// Authored appendage paths for appearance mapping version 1. Without gene parts (the studio
// editor), the original shell-v1 legs are drawn unchanged.
const appendagePaths = {
  stubs: { d: 'M 390 740 Q 372 800 360 836 M 610 740 Q 628 800 640 836', width: 40 },
  fins: { d: 'M 345 700 Q 280 870 230 800 M 655 700 Q 720 870 770 800', width: 32 },
  streamers: {
    d: 'M 330 690 Q 220 820 160 760 Q 110 720 70 790 M 670 690 Q 780 820 840 760 Q 890 720 930 790',
    width: 22,
  },
} as const;
const plateOffsets = { smooth: [], ridged: [-100, 0, 100], armored: [-180, -90, 0, 90, 180] };

/** Only supported authored paths are rendered. No uploaded SVG, CSS, URLs, or text. */
export function ShellRenderer({
  part,
  rendererVersion = 'shell-v1',
  parts,
  label = 'Community shell preview',
  interactive = false,
  children,
}: {
  part: ShellPart;
  rendererVersion?: string;
  /** Gene-linked parts from a persisted appearance mapping version. */
  parts?: GeneAppearance;
  label?: string;
  /** Editable drawings expose their focusable handles as a group; static art is one image. */
  interactive?: boolean;
  children?: ReactNode;
}) {
  const clipId = 'shell-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const parsed = shellPartSchema.safeParse(part);
  if (!parsed.success || rendererVersion !== 'shell-v1') {
    return <p role="alert">This shell version is unsupported. Your saved design has been kept.</p>;
  }
  const design = parsed.data;
  const { path } = shellGeometry(design.parameters);
  const colors = palettes[design.marking.paletteId];
  const appendage = appendagePaths[parts?.appendages ?? 'fins'];
  const top = 500 - design.parameters.height / 2;
  return (
    <svg
      viewBox="0 0 1000 1000"
      role={interactive ? 'group' : 'img'}
      aria-label={label}
      data-renderer="shell-v1"
      data-appendages={parts?.appendages}
      data-plating={parts?.plating}
    >
      <title>{label}</title>
      <defs>
        <clipPath id={clipId}>
          <path d={path} />
        </clipPath>
      </defs>
      <ellipse cx="500" cy="865" rx="280" ry="24" fill="#101820" opacity="0.5" />
      <path
        d={appendage.d}
        stroke={colors.fill}
        strokeWidth={appendage.width}
        fill="none"
        strokeLinecap="round"
      />
      <path
        d={path}
        fill={colors.fill}
        stroke={colors.edge}
        strokeWidth={parts?.plating === 'armored' ? 24 : 12}
      />
      <g clipPath={`url(#${clipId})`} fill={colors.detail} stroke={colors.edge} strokeWidth="5">
        {design.marking.patternId === 'bands' &&
          [360, 500, 640].map((x) => (
            <path
              key={x}
              d={`M ${x} 70 Q ${x - 120} 500 ${x} 920 L ${x + 35} 920 Q ${x - 85} 500 ${x + 35} 70 Z`}
            />
          ))}
        {design.marking.patternId === 'dots' &&
          [330, 500, 670].flatMap((x) =>
            [330, 490, 650].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="25" />),
          )}
        <path
          d="M 500 90 L 500 880"
          stroke={colors.edge}
          fill="none"
          opacity="0.22"
          strokeWidth="10"
        />
        {plateOffsets[parts?.plating ?? 'smooth'].map((offset) => (
          <path
            key={offset}
            d={`M ${500 + offset - 34} ${top + 58} Q ${500 + offset} ${top + 18} ${500 + offset + 34} ${top + 58}`}
            fill="none"
            stroke={colors.edge}
            strokeWidth="14"
            strokeLinecap="round"
            data-plate=""
          />
        ))}
      </g>
      <ellipse cx="445" cy="650" rx="18" ry="25" fill={colors.edge} />
      <ellipse cx="555" cy="650" rx="18" ry="25" fill={colors.edge} />
      <path
        d="M 465 706 Q 500 727 535 706"
        stroke={colors.edge}
        strokeWidth="10"
        fill="none"
        strokeLinecap="round"
      />
      {children}
    </svg>
  );
}
