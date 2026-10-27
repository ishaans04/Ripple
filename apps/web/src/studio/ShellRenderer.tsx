import { useId, type ReactNode } from 'react';
import { shellPartSchema, type ShellPart } from '@ripple/contracts';
import { shellGeometry } from './shellGeometry.ts';

const palettes = {
  'teal-amber': { fill: '#56d6c5', detail: '#f0bd68', edge: '#122e36' },
  'coral-ink': { fill: '#ef957f', detail: '#f6dba3', edge: '#302d43' },
  'moss-cream': { fill: '#b1c997', detail: '#f5eccf', edge: '#293c39' },
} as const;

/** Only supported authored paths are rendered. No uploaded SVG, CSS, URLs, or text. */
export function ShellRenderer({
  part,
  rendererVersion = 'shell-v1',
  children,
}: {
  part: ShellPart;
  rendererVersion?: string;
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
  return (
    <svg
      viewBox="0 0 1000 1000"
      role="img"
      aria-label="Community shell preview"
      data-renderer="shell-v1"
    >
      <title>Community shell preview</title>
      <defs>
        <clipPath id={clipId}>
          <path d={path} />
        </clipPath>
      </defs>
      <ellipse cx="500" cy="865" rx="280" ry="24" fill="#101820" opacity="0.5" />
      <path
        d="M 345 700 Q 280 870 230 800 M 655 700 Q 720 870 770 800"
        stroke={colors.fill}
        strokeWidth="32"
        fill="none"
        strokeLinecap="round"
      />
      <path d={path} fill={colors.fill} stroke={colors.edge} strokeWidth="12" />
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
