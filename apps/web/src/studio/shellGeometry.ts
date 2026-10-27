import { shellParametersSchema, type ShellParameters } from '@ripple/contracts';

export type ShellParameter = keyof ShellParameters;
export interface EditorPoint {
  readonly x: number;
  readonly y: number;
}
export function shellGeometry(value: ShellParameters): {
  readonly path: string;
  readonly handles: Readonly<Record<ShellParameter, EditorPoint>>;
} {
  const { width, height, curvature } = shellParametersSchema.parse(value);
  const left = 500 - width / 2;
  const right = 500 + width / 2;
  const top = 500 - height / 2;
  const bottom = 500 + height / 2;
  return {
    path: `M ${left} 500 Q ${left} ${top} 500 ${top - curvature / 8} Q ${right} ${top} ${right} 500 Q ${right} ${bottom} 500 ${bottom} Q ${left} ${bottom} ${left} 500 Z`,
    handles: {
      width: { x: right, y: 500 },
      height: { x: 500, y: top },
      curvature: { x: 500 - width / 4, y: top - curvature / 8 },
    },
  };
}
export function pointToParameter(
  key: ShellParameter,
  point: EditorPoint,
  parameters: ShellParameters,
): number {
  switch (key) {
    case 'width':
      return Math.round((point.x - 500) * 2);
    case 'height':
      return Math.round((500 - point.y) * 2);
    case 'curvature':
      return Math.round((500 - parameters.height / 2 - point.y) * 8);
  }
}
