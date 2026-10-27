# Delivery progress

## Phase 2 — studio rules and editor (in progress)

Phases 0 and 1 are implemented. Before Phase 2, the explanation contribution list is corrected to include the final health clamp; its property test now checks actual energy changes for applied rounds and estimated changes for limited rounds.

The four open Phase 2 policies are resolved as follows:

- **Keep current:** completes selection without approval, hatch, or game changes and releases any reservation. Empty shortlists and no votes choose this outcome.
- **Ties:** Keep current wins any tie involving it. Ties between finalists retain their recorded seeded order. Keep current remains the last numbered option.
- **Cosmetic hatches:** use the same eligible future mutation slot as genetic studio results. This preserves the round checkpoint, avoids two changes in one slot, and cannot create extra mutations. The genome and fitness stay unchanged.
- **Founder appearance:** a neutral `shell-v1` segmented shell is the versioned default. It has no studio/artist attribution or genetic effect. A committed design replaces that appearance; descendants inherit only committed appearance.

Phase 2 builds the pure studio rules, shared contracts, versioned renderer, local editor, and browser-local hand tracking. Live proposals, artist OAuth, server sessions, and authoritative hatches remain Phase 8 work as required by the plan.

Exit evidence pending: property tests; complete local editor; real MediaPipe worker under production security headers in Windows Chrome and Edge; browser parity, tracking-loss, camera-denial and lifecycle checks. Phase 3 has not started.
