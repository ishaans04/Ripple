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

## Phase 3 — event backbone (complete)

Delivered in 17 focused commits, including this exit record. The schema, durable intake and per-channel worker, round checkpoints, deadline leases, event history, outbox, snapshot-first gateway, browser recovery transport, isolated synthetic CLI, and accepted-record reconstruction are implemented.

Exit evidence on code commit `0a41ed4`:

- [CI run 40554783676](https://github.com/ishaans04/Ripple/actions/runs/40554783676) passes all three jobs: lint/format/types/build with 377 unit tests and 54 actual PostgreSQL tests, all 12 Windows Chrome/Edge studio journeys, and the production-image Compose journey.
- The Compose journey runs the installed command tool, seeds a synthetic organism, accepts a vote, completes a confident three-account observation, resolves health, reads the authorized HTTP snapshot, and connects to the actual snapshot-first WebSocket. It prints no owner/read capabilities.
- Database tests cover concurrent duplicate receipts, cross-channel receipt conflicts, competing ordered workers, close/ingress races, stale/expired/cancelled leases, a leased marker still being dispatched, and world expiry. An injected outbox failure rolls back state, cursor, history and public writes together. A real child worker is killed immediately after committing; a new worker sees the committed effect and durable outbox without applying it twice.
- Offline/manual pauses retain active time. Input gaps retain committed genes, hold health and qualification, and require recorded recovery with a fresh observation epoch. A discovered manual-pause/outage deadlock and empty-channel pause publication were corrected. Complete limited-confidence rounds still satisfy the mutation clock while holding health.
- Read capabilities are hashed; browser tickets expire after 30 seconds and are single-use. Gateway tests cover world isolation, snapshot/reconnect races, independent gateway catch-up, write denial, authority revocation, and recoverable slow-consumer closure. Browser transport tests cover bounded retries, duplicate/version handling, stale sockets, heartbeat loss, offline return, and cancelled exchanges.
- Accepted records retain rules/engine versions, seeds, genesis, order, inputs and results with linked checksums. Reconstruction in a separate replay world reproduces lineage, organism state, round history, baselines and explanations without changing the source. Cross-channel and studio replay will extend these records in the phases that implement those mechanics; the full replay CLI remains Phase 9.
- Database guards freeze rules, genesis, ancestry, accepted inputs, first votes, baseline membership, closed rounds, audit events and public projections. Parent/child creation checks the same world/lineage, immediate generation and captured genome.
- Unit workers are bounded to four or available CPUs. Cold Fastify compiler initialization is suite setup; request assertion timeouts remain unchanged. No retries or skipped assertions establish this gate.
- All commits use `ishaans04 <sharmaishaaan04@gmail.com>` as author and committer, with no co-author trailers. GitHub lists only `ishaans04` as collaborator and contributor, with zero pending collaborator invitations.

The local database remains intact. Custom-format backups are saved under ignored `tmp/ripple-before-phase3.dump` and `tmp/ripple-phase3-loop.dump`; this is not a backup-restore rehearsal claim. That release exercise remains Phase 10.

## Phase 4 — Twitch live loop (implementation complete; live acceptance pending)

Delivered in 17 focused commits, including this exit record. Broadcaster/operator OAuth, encrypted grants, signed EventSub intake and subscription recovery, normalized local chat, stream/category lifecycle, bot announcements, controller setup states and Railway deployment configuration are implemented. Real Twitch and hosted acceptance remain pending under the user's explicit deferral.

Live configuration is opt-in and fails closed on missing secrets or a non-HTTPS public origin. Grant ciphertext uses AES-256-GCM with grant-identity authenticated data; actor hashing uses a separate key. No live acceptance is claimed.

Implemented: browser-bound broadcaster and separate operator-bot OAuth, per-grant refresh leases and startup/hourly validation, revocation-driven session termination, exact raw-byte webhook HMAC, subscription challenge/reconciliation and transport-key binding, conservative Shared Chat locality and semantic deduplication, per-ballot/per-observation actor keys derived by the ordered worker, independent stream/input-health commands, REST lifecycle reconciliation with stale-response fencing, versioned/idempotent owner seeding/naming/pause/recovery/policy controls, and committed bot outbox delivery with bounded rates and uncertain-send handling. The controller and read-only preview have eight additional Chrome/Edge journeys.

Phase 4 policy choices: empty channels may reseed 180 seconds after their last committed seed; strain names are approved by the owner, bounded to 40 characters, reject control/bidirectional formatting characters, and render as text. Sessions expire after twelve hours and use an independent rotatable HMAC key. Subscription attempts back off for 90 seconds, reconciliation runs every 30 seconds, and bot delivery allows twelve attempts/minute globally and one/ten seconds/channel. No payment-related event or scope is enabled.

The [live setup guide](twitch-setup.md) records account/application registration, exact OAuth/webhook URLs, Railway configuration, independent secrets, operator/broadcaster flows, recovery, credential rotation and the real-channel acceptance journey. No deployment or real Twitch evidence is claimed.

Exit evidence on code commit `a88a53a`:

- All three jobs of [CI run 40652223830](https://github.com/ishaans04/Ripple/actions/runs/40652223830) pass: lint, formatting, types, production build, 386 unit tests, 67 PostgreSQL integration tests, 20 Windows Chrome/Edge browser journeys and the production-image Compose round/HTTP/WebSocket journey.
- Provider fixtures exercise real PostgreSQL and application routes, including browser state theft/reuse, operator/broadcaster separation, encrypted grants, serialized expired-token refresh, revoked and expired authority, CSRF/ownership/version/idempotency checks, signed raw bytes, challenge-before-create-response, semantic duplicate chat, Shared Chat exclusion, stale REST lifecycle results, clean offline/manual pause/outage recovery, and bot concurrency/uncertain delivery/global attempt limits. These fixtures are not live Twitch evidence.
- Controller layouts were visually inspected at 1280px and 390px widths with an explicitly synthetic state. Local ignored screenshots are under `tmp/phase4-controller-*.png`. No physical-device or OBS-readability claim is made.
- The first full local PostgreSQL run passed 66/67 tests; the migration idempotency test exceeded its five-second limit under local load. An isolated rerun passes all migration tests, and the complete CI PostgreSQL run passes 67/67 without timeout changes, retries or skipped assertions.
- A pre-migration local backup is retained at ignored `tmp/ripple-before-phase4.dump`. This remains distinct from the Phase 10 backup/restore rehearsal.
- The local Compose image was rebuilt, all 19 migrations applied, both services became healthy, and the installed smoke tool completed a real synthetic seed/vote/habitat/resolution plus authorized HTTP and snapshot-first WebSocket. `/api/connection` correctly reports live mode disabled without credentials.
- All commits retain `ishaans04 <sharmaishaaan04@gmail.com>` as author and committer, with no co-author trailers.

## Phase 5 — raids and lineage (next)

Next implement sorted-lock transactional child creation, outgoing raid receipt, preparation and welcome ballots, all ten admission outcomes, shelter/contest/fossil transitions, resource caps/cooldowns and ballot arbitration. Only Phase 5 is next; Phase 6 work has not started. Real two-channel raid acceptance remains pending the same account/HTTPS setup.

## Live acceptance deferral requested by the user

The two broadcaster accounts, operator bot, and public HTTPS URL are not set up. Continue sequential implementation with sandbox/synthetic verification where possible. Keep all authentic Twitch, raid, OBS, and hosted acceptance evidence explicitly pending, with no synthetic test represented as live evidence. Provide the account/application/OAuth/HTTPS setup steps when Phase 4 needs them. This user-directed deferral permits continued implementation; it does not satisfy the PRD's final release gate.
