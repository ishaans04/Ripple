# Delivery progress

## Phase 2 — studio rules and editor (complete)

Phases 0 and 1 are implemented. Before Phase 2, the explanation contribution list is corrected to include the final health clamp; its property test now checks actual energy changes for applied rounds and estimated changes for limited rounds.

The four open Phase 2 policies are resolved as follows:

- **Keep current:** completes selection without approval, hatch, or game changes and releases any reservation. Empty shortlists and no votes choose this outcome.
- **Ties:** Keep current wins any tie involving it. Ties between finalists retain their recorded seeded order. Keep current remains the last numbered option.
- **Cosmetic hatches:** use the same eligible future mutation slot as genetic studio results. This preserves the round checkpoint, avoids two changes in one slot, and cannot create extra mutations. The genome and fitness stay unchanged.
- **Founder appearance:** a neutral `shell-v1` segmented shell is the versioned default. It has no studio/artist attribution or genetic effect. A committed design replaces that appearance; descendants inherit only committed appearance.

Phase 2 builds the pure studio rules, shared contracts, versioned renderer, local editor, and browser-local hand tracking. Live proposals, artist OAuth, server sessions, and authoritative hatches remain Phase 8 work as required by the plan.

Delivered in 21 focused commits, including this exit record. The local editor is available at `/studio`; it does not pretend to be a live proposal/session service.

Exit evidence:

- 363 unit tests across 37 files and 11 actual PostgreSQL integration tests pass.
- All 12 browser journeys pass in Windows Chrome and Edge, including real model inference inside the module worker under production CSP, synthetic-landmark/pointer blueprint equality, tracking loss without submission, permission denial without automatic re-prompting, model failure with retained editing, touch dragging, keyboard undo, local recovery, and confirmed downloads.
- Local browsers: Chrome 156.0.8078.48 and Edge 155.0.4283.45. Inference uses the upstream test photograph; no physical-camera/device performance claim is made. The Phase 10 device/network matrix remains required.
- A CI-discovered stale autosave-status race was fixed with immediate bounded-record persistence, a page-exit flush, and a status tied to the exact current draft. The recovery journey passed three repeated runs in each browser after that fix.
- Lint, formatting, workspace and browser-test types, production build, and Compose smoke checks pass. The Docker-served studio returns the scoped camera policy; the copied WASM has `application/wasm` MIME.
- All three jobs of [CI run 40537529444](https://github.com/ishaans04/Ripple/actions/runs/40537529444) pass on code commit `2e89d45`.
- Every commit is authored and committed by `ishaans04`; no co-author trailers are present.

The shared mutation clock requires a completed active observation between slots. Limited-confidence but complete observation can satisfy that clock; interrupted/missing intervals cannot. Confidence separately controls health, trace, and contest progression, so small communities are not barred from ordinary genetic choices.

## Phase 3 — event backbone (in progress)

Build the world-scoped schema, ordered durable intake, pure round transitions, transactional worker and event/outbox writes, leased deadlines, pause/interruption recovery, snapshot-first read-only WebSockets, and isolated synthetic adapter. Required database tests include duplicate receipts, crash-after-commit recovery, and close/ingress races.

Implemented and tested so far: world-scoped schema and identity constraints; atomic receipt deduplication and sequence allocation; pure active-time checkpoints; ordered round worker with atomic event/outbox writes; limited-confidence progression; deadline leasing, cancellation and fencing; runtime ownership and process-gap interruption; scoped read capabilities and single-use browser tickets; snapshot-first read-only WebSockets with durable multi-gateway catch-up; and the owner-authorized synthetic CLI and retry-safe clock. Real PostgreSQL tests cover concurrent receipt delivery, competing workers, close/ingress races, recovery after commit, fresh observation epochs after outages, ticket expiry/revocation, socket writes, slow consumers, and paused synthetic time. The CLI has run a seeded ballot, three-account observation, and actual resolution against the local database. Replay verification and the complete phase exit checks remain in progress. Synthetic fixtures using live-mode database rows test recovery policy only; they are not Twitch integration evidence.

CI is green through runtime commit `0e60f9f` ([run 40543552935](https://github.com/ishaans04/Ripple/actions/runs/40543552935)). Before migrating the persistent local development database, a PostgreSQL custom-format backup was saved under ignored `tmp/ripple-before-phase3.dump`; integration suites continue using isolated disposable databases.

## Live acceptance deferral requested by the user

The two broadcaster accounts, operator bot, and public HTTPS URL are not set up. Continue sequential implementation with sandbox/synthetic verification where possible. Keep all authentic Twitch, raid, OBS, and hosted acceptance evidence explicitly pending, with no synthetic test represented as live evidence. Provide the account/application/OAuth/HTTPS setup steps when Phase 4 needs them. This user-directed deferral permits continued implementation; it does not satisfy the PRD's final release gate.
