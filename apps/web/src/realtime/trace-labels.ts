import type { MechanicsState, TraceView } from '@ripple/contracts';
export const traceTitle: Readonly<Record<TraceView['template'], string>> = {
  charged: 'Charged habitat',
  shelter: 'Shelter',
  recovery: 'Recovery zone',
};
export function traceEffectText(
  template: TraceView['template'],
  rules: MechanicsState['traceRules'],
): string {
  return template === 'charged'
    ? `Fitness +${rules.chargedAdjustment} when burst is at least ${rules.chargedBurstThreshold}; fitness -${rules.chargedAdjustment} otherwise.`
    : template === 'shelter'
      ? `Arrival raw shock reduced by ${rules.shelterArrivalShockReduction}; upkeep increases by ${rules.shelterUpkeep}.`
      : `Energy delta +${rules.recoveryAdjustment} below ${rules.recoveryHealthThreshold} start energy; -${rules.recoveryAdjustment} otherwise.`;
}
