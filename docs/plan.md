# Ripple delivery plan

This plan sequences the [PRD](prd.md) feature register (P01-P40) into phases. Phases run strictly in order; a phase starts only after the previous phase meets its exit criterion. The order follows the PRD's dependency order (section 23), with one change: a synthetic input adapter is built with the event backbone so the game can be developed and demonstrated without live Twitch credentials.

| Phase | Scope | Requirements | Exit criterion |
| --- | --- | --- | --- |
| 0. Foundation | npm workspaces, strict TypeScript, lint, Vitest, Compose with PostgreSQL 18, Drizzle migrations, Fastify with health checks, GitHub Actions, environment example | P30 (start), P37 (start) | `docker compose up --build` serves http://localhost:3000; CI green |
| 1. Pure engine | Seeded generator, ruleset canonical JSON and hash, genome legality, three-candidate generation, tally with ties and no-vote Hold, burst/steadiness, baseline and confidence, integer scoring, health and extinction, explanation templates | P03-P06, P18 | Property tests pass; the PRD section 25.4 worked journey reproduces exactly |
| 2. Event backbone | Full schema, per-channel ordered inbox, ordered worker, deadline leases, round state machine, pause and INTERRUPTED handling, game events, transactional outbox, snapshot-first WebSocket gateway, synthetic input adapter | P24, P25, P28, P31/P32 core | Real-PostgreSQL integration tests including duplicate delivery, crash after commit, and close-versus-ingress races |
| 3. Twitch live loop | Broadcaster OAuth and operator bot flow, encrypted tokens, EventSub HMAC intake and subscription management, chat normalization (Shared Chat, actor hashing, 10-second caps), stream lifecycle, category updates, bot announcements, controller setup states, Railway deployment | P01, P02, P13, P31, P36 (part) | A real chat vote on a real channel resolves a real ballot |
| 4. Raids and lineage | Transactional child creation with sorted locks, preparation ballot, every admission and harbor outcome, welcome ballot, contest and shelter, fossils, caps and cooldowns, ballot arbitration | P07-P12, P16 | A real two-channel raid; all ten admission outcomes tested |
| 5. Novel mechanics | Habitat traces, dormant mutations, ancestor trials, alternative replay, choice preview | P19-P23 | Lifetime, expiry, migration, and zero-side-effect tests pass |
| 6. Product surfaces | Overlay states, controller, passport and lineage map, inherited appearance, descendant updates, accessibility, optional celebrations | P14, P15, P17, P26, P27, P35, P38 | Readable in a real OBS capture; Playwright journeys pass |
| 7. Sandbox and tooling | Full judge sandbox with reset and replay, simulator and policy comparisons, replay CLI, analytics events, balance evidence | P29, P33, P34, P39 | A clean machine completes the judge journey in under three minutes |
| 8. Hardening and release | Fault and adversarial suites, load test, runbooks, backup and restore rehearsal, README, two-channel rehearsal, demo video, submission package | P32, P36, P37, P40 | PRD section 21.3 release gate |

## Working rules

- Every feature is implemented as specified in the PRD; no placeholder implementations.
- Each phase is delivered as a series of focused commits pushed to the main repository.
- The README is updated as capabilities land, describing only what actually works.
