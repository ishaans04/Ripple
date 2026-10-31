import { founderShell, type ShellPart } from '@ripple/contracts';
import { sequence, type GuideStep, type TourStop } from '../console/guide.ts';

export interface StudioProgress {
  readonly cameraOn: boolean;
  readonly part: ShellPart;
  readonly tradeChosen: boolean;
  readonly saved: boolean;
  readonly live: boolean;
}

/** Studio steps fill in from the actual draft, never from a scripted timer. */
export function studioSteps({
  cameraOn,
  part,
  tradeChosen,
  saved,
  live,
}: StudioProgress): GuideStep[] {
  const shaped =
    part.parameters.width !== founderShell.parameters.width ||
    part.parameters.height !== founderShell.parameters.height ||
    part.parameters.curvature !== founderShell.parameters.curvature;
  const signed =
    part.marking.patternId !== founderShell.marking.patternId ||
    part.marking.paletteId !== founderShell.marking.paletteId;
  return sequence([
    {
      id: 'hands',
      target: 'studio-hands',
      title: 'Wake your hands',
      detail: 'Press Enable hand controls, or skip it and sculpt with a mouse, finger or keys.',
      done: cameraOn || shaped,
    },
    {
      id: 'shape',
      target: 'studio-stage',
      title: 'Pull a white point',
      detail:
        'Pinch thumb and index finger over a white point, or drag it. Move, then let go to set it.',
      done: shaped,
    },
    {
      id: 'trade',
      target: 'studio-trade',
      title: 'Choose the trade-off',
      detail: 'Pick which gene pays for a stronger shell, or keep the design cosmetic.',
      done: tradeChosen,
    },
    {
      id: 'sign',
      target: 'studio-sign',
      title: 'Sign it',
      detail: 'Choose a marking and a palette so the community can recognise your shell.',
      done: signed,
    },
    {
      id: 'save',
      target: 'studio-save',
      title: live ? 'Send it to chat' : 'Keep your design',
      detail: live
        ? 'Check the trade-off and submit. Nothing changes until chat picks it and the broadcaster approves.'
        : 'Download your design. Practice designs stay on this device.',
      done: saved,
    },
  ]);
}

export const studioTour: readonly TourStop[] = [
  {
    target: 'studio-stage',
    title: 'Your shell',
    body: 'This is the creature’s shell. The three white points sculpt its width, its height and the arch of its crown.',
  },
  {
    target: 'studio-hands',
    title: 'Sculpt with your hands',
    body: 'Enable hand controls and hold a hand up to the camera. A ring on the stage follows your index finger; pinch over a white point, move, then open your fingers to let go.',
  },
  {
    target: 'studio-trade',
    title: 'The trade-off',
    body: 'A stronger shell costs a little of another gene. Choose which one, or keep the design purely cosmetic.',
  },
  {
    target: 'studio-shape',
    title: 'Fine tuning',
    body: 'Sliders mirror the white points exactly, for precise numbers or keyboard control.',
  },
  {
    target: 'studio-sign',
    title: 'Your signature',
    body: 'A marking and a palette make the shell recognisably yours.',
  },
  {
    target: 'studio-save',
    title: 'Keep it',
    body: 'Save or submit when you are happy. Your draft is also kept on this device as you work.',
  },
];
