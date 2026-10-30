# Phase 10 hardening and release evidence

Recorded 31 October 2026. Phase 10 starts after the Phase 9 exit `1662f8f`. The principal Codex session and earlier real repair/balance evidence are recorded in [Phase 9](phase9.md). This record covers actual implementation and synthetic verification; authentic Twitch, OBS, public HTTPS and operator-hosted acceptance remain explicitly deferred. A release candidate is not a claim that the PRD section 21.3 genuine-integration gate has passed.

## Checklist and reproducible evidence

| Plan requirement | Working behavior and verification |
| --- | --- |
| Fault/adversarial suites | Real PostgreSQL tests cover before-commit backend termination and retry, final-write rollback, an actual worker killed after commit, reciprocal sorted-lock raids, repeated raid/round-close races, vote/close ordering, competing studio voters and approvals, duplicate commitments/deadlines, persisted restart recovery, revoked grants and refresh, stale versions, world isolation and bounded slow sockets. See `recovery`, `worker`, `propagation`, `studio-edges`, `studio-lifecycle`, `gateway`, Twitch and privacy integration suites. |
| Load across artists/channels | The strict native Linux workload uses 100 enrolled channels, 300 real TCP WebSockets, 20 studios, 60 distinct artists in the largest studio and 174 accepted proposals (29 during HTTP intake), 60 seconds at two signed chat notifications/channel/second, a 10x burst on ten channels, 30 reconnects and an actual worker killed immediately after a committed mutation. Reports include percentiles, errors, backlog, convergence, row sizes, process CPU/RSS and cumulative PostgreSQL I/O. |
| Client/device/network | Installed Windows Chrome/Edge run the real pinned model/worker on a licensed image under 4x CPU throttling. Separate in-page input-to-next-frame and animation-frame p95 budgets are 100/150 ms, with at most one frame in flight and no design writes during editing. Hidden processing stops, and late bitmaps are closed. Slow/failed/corrupt model loading, camera denial/unavailability, tracking loss, offline draft persistence, one/two-hand gesture rules, equal pointer parameters and reconnect during vote/hatch have browser/unit coverage. Physical camera/lighting/GPU and real OBS acceptance still need the intended operator device. |
| Runbooks | [Operations](../operations.md) covers database failure, post-commit crashes, poisoned input, grant revocation, stale OBS, camera support, model/worker failure, renderer compatibility, socket backpressure, backups and rollback. `npm run status` gives private mode-separated lag/deadline/delivery/database diagnostics. |
| Identity retention/deletion | Separate expiring identity vault and opaque replay credit tokens; authenticated origin/CSRF-protected forgetting; immediate session invalidation; public privacy notice; bounded 30-second maintenance; raw-input expiry while compact receipts preserve duplicates; expired-world purge; separate erasure-ledger export/reapply. Real SQL tests verify deletion without changing accepted replay and post-backup erasure recovery. See [privacy operations](../privacy-operations.md). |
| Backup/restore | Real PostgreSQL 18 custom-format dump into a separate empty database, matching migrations, post-snapshot erasure reapplied before publication, exact accepted history, two canonical channel projections and accepted-record-only replay. [Measured restore report](phase10-restore.json). The fixture snapshot is not a hosted RPO/RTO promise. |
| Notices/installation | All 114 production npm packages have full license/notice text in the [generated inventory](../licenses/npm-runtime.json); pinned model/runtime and licensed test-image attribution are in [third-party notices](../../THIRD_PARTY_NOTICES.md). Notices ship at `/licenses/`. CI checks the inventory, clean Docker build, readiness, synthetic tools and actual installed browser without intercepted requests. |
| Documentation/package | [Deployment](../deployment.md), [submission/handoff](../submission.md), README, environment example and package verifier provide the exact source/archive/CI/evidence path. Packaging requires a clean worktree, exact-HEAD green CI, valid measured gates and at least 15 correctly authored Phase 10 commits. |
| Rehearsal/demo | The real two-channel synthetic studio-to-raid path and deterministic replay are exercised through installed API/browser tools and the restore fixture. The [recorded demo](../demo/README.md) permanently labels synthetic events and accelerated time. Genuine Twitch/OBS/physical hand footage and public submission remain operator acceptance tasks. |

## Actual performance investigation

An actual TCP test exposed a gateway defect: successful WebSocket callbacks can pass `null`, which was incorrectly treated as a send error and terminated every real socket. The fix keeps successful writes open; real-socket and 300-client convergence checks verify it. Durable topic catch-up is fetched in one batched query per gateway poll.

Native Linux CI initially measured public-update p95 at 2,684 ms. Ownership renewal, bounded scheduling and byte-identical activity batching measured 2,039, 1,383 and 1,580 ms across subsequent runs. Prepared snapshot/context plans first passed at 377 ms on `60ae36d`, but a repeat on `788bbea` missed at 1,513 ms; that first pass was not treated as sufficient final evidence. Combined transactional writes, indexed measurement reads and concurrent deadline cohorts reduced redundant work while keeping receipt/cursor/payload rollback atomic. Two independent trials on `f1d2ceb` still measured 934/1,188 ms, so the [last failed baseline](phase10-load-before.json) is retained rather than hidden.

The final correction commits a bounded, genuine vote-count aggregate in the same transaction as the vote and accepted record. Gateways hydrate authoritative complete snapshots after commit, at the existing 500-ms vote aggregation cadence, with eight bounded topic publishers. Large read projections no longer hold the channel's intake lock. Structural results still commit with their complete projection; mixed changes rebase to the newest authoritative snapshot. Clients keep the same complete-view protocol, privacy resolution and gap recovery; older complete outbox rows remain supported. Real TCP tests verify compact stored counts, full schema-valid public frames and current state. Twenty-five worker/recovery/studio/gateway journeys pass, followed by the complete regression and both strict capacity trials. No callback durability, workload, retries or latency threshold was relaxed.

Privacy verification also exposed an account-limit bypass: random participation keys could reset on forgetting/sign-in. Participation now retains a world-scoped key derived from the installation-secret account HMAC; forgetting still deletes sessions and credit mapping, and fresh credit never restores an erased token. A real PostgreSQL regression verifies that artist blocks survive re-authentication. The notice and recovery runbook describe pseudonymous provenance and conservative ledger reapplication.

## Passing release-candidate measurements

All five jobs of [CI 41142407808](https://github.com/ishaans04/Ripple/actions/runs/41142407808) on `25a01c2792a0c0eacea234d3772441b85d9cc476` pass: formatting/lint/types/notices/build, 467 unit tests, 223 real-PostgreSQL tests, 98 installed Windows Chrome/Edge journeys with zero retries, held-out simulator scenarios, two independent strict native load trials, and a clean Linux Compose installation including all smoke tools, actual installed judge and real backup restoration. No test was skipped or weakened to obtain this result. The final documentation/evidence revision repeats CI; packaging requires both measured trial reports and green CI on its exact HEAD.

The [first](phase10-load.json) and [second](phase10-load-trial2.json) passing native reports record Linux, Node 24.22.1, PostgreSQL 18.6, four logical CPUs, approximately 16 GB RAM, a 32-connection application pool and up to 24 independent channel workers with four ordered inputs per turn. Trial 1 uses AMD EPYC 7763 and trial 2 AMD EPYC 9V45; these are different shared CI machines, not a controlled same-host experiment. The harness and app are separate processes on each host. Twitch network/TLS and hosted capacity are not inferred.

| Measured latency (ms) | Trial 1 p95 | Trial 2 p95 | Gate |
| --- | ---: | ---: | --- |
| Durable HTTP callback | 222.8 | 121.6 | p95 < 500 |
| All input to observed commit | 721 | 311 | p95 < 1,000 |
| Input producing public update to observed commit | 827 | 334 | p95 < 1,000 |
| Actual public WebSocket frame | 888 | 338 | reported separately |

In each independent trial, all 12,180 notifications were acknowledged, all 174 proposals accepted, no acknowledged work remained, no errors or duplicate commitments occurred, and all 300 sockets converged, including 30 reconnects. A separately killed worker committed exactly one rename and one outbox update; the receipt was reused, restart applied nothing twice, and all 300 sockets converged again. Fault timing is outside the 60-second steady-state interval. Reports retain p50/p95/p99/max, actual row sizes (including compact vote outbox payloads), application CPU microseconds/RSS and cumulative PostgreSQL counters. Commit/frame timing begins before sending each local HTTP request, and commit samples include polling overhead; the public subset is gated separately. These are conservative measured samples, not a production SLA.

Client measurements are separate from server latency. Earlier local Windows 11/i7-1260P/approximately 16 GB checks recorded input-to-next-frame p95 26.5/64 ms in Chrome/Edge. The committed [Chrome](phase10-client-chrome.json) and [Edge](phase10-client-edge.json) reports are the final implementation's green CI revision on Windows 11/EPYC/four logical CPUs/approximately 16 GB, with 4x CPU emulation: paint p95 20.4/19.8 ms, animation-frame p95 16.8/16.8 ms, one frame in flight and zero editing writes. Tests use real inference on a licensed image, not a physical camera or universal low-end device claim. Automation transport is reported separately from browser paint time.

The [green CI restore report](phase10-restore.json) records a 237,247-byte custom dump, 221 ms dump, 387 ms restore and 412 ms replay, equality for both channels and successful post-backup identity erasure. These are quiescent synthetic-fixture timings, not hosted recovery promises. The installed judge browser completed in 5,058 ms with zero intercepted requests; its API counterpart completed in 1,437 ms with both channel projections equal and zero replay divergence.

## Reproduce

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run test:load -- --seconds 60 --channels 100 --strict --output tmp/release-load.json
docker compose up --build --detach --wait
npm run test:judge
npm run test:restore
node tests/dependency-notices.ts --check
npm run release:package
```

The database tests/load harness require a PostgreSQL 18 administrative `TEST_DATABASE_URL` and create/drop only generated fixture databases. The restore tool also verifies that this URL points to Compose before using its PostgreSQL client. Run browser suites serially relative to each other to avoid sharing their fixture port/artifacts. Repeat the strict load command independently for a second report; CI requires both trials, without retries, and packaging validates both committed reports. Package last, after committing and exact-revision green CI.
