import { describe, expect, it } from 'vitest';
import { founderShell } from '@ripple/contracts';
import { nextStep } from '../console/guide.ts';
import { studioSteps } from './studioGuide.ts';

const base = {
  cameraOn: false,
  part: founderShell,
  tradeChosen: false,
  saved: false,
  live: false,
};

describe('studio guide', () => {
  it('starts by inviting hands or pointer', () => {
    expect(nextStep(studioSteps(base))?.id).toBe('hands');
  });

  it('treats a pointer edit as choosing to sculpt without the camera', () => {
    const part = { ...founderShell, parameters: { ...founderShell.parameters, width: 700 } };
    expect(nextStep(studioSteps({ ...base, part }))?.id).toBe('trade');
  });

  it('asks for a pull after the camera wakes', () => {
    expect(nextStep(studioSteps({ ...base, cameraOn: true }))?.id).toBe('shape');
  });

  it('marks signing from the actual marking and finishes when saved', () => {
    const part = {
      ...founderShell,
      parameters: { ...founderShell.parameters, height: 500 },
      marking: { ...founderShell.marking, patternId: 'dots' as const },
    };
    const steps = studioSteps({ ...base, part, tradeChosen: true });
    expect(nextStep(steps)?.id).toBe('save');
    expect(nextStep(steps)?.title).toBe('Keep your design');
    expect(nextStep(studioSteps({ ...base, part, tradeChosen: true, saved: true }))).toBeNull();
  });

  it('names submission for a live studio', () => {
    const steps = studioSteps({ ...base, live: true });
    expect(steps.find((step) => step.id === 'save')?.title).toBe('Send it to chat');
  });
});
