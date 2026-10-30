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

Native Linux CI initially measured public-update p95 at 2,684 ms. Renewing worker ownership once per cycle and bounding channel scheduling reduced it to 2,039 ms. Byte-identical ordinary-activity batching measured 1,383 ms on `904fa4c`; callback p95 was 204 ms and all-input observed-commit p95 922 ms, with all 12,180 callbacks acknowledged, all 174 proposals accepted, no errors or duplicate commitments, all 300 sockets converged and actual post-commit kill/retry passing. Removing empty-channel transactions and duplicate vote/deadline lookups measured 1,580 ms on `f872c69` with 24 concurrent channels, so that change alone did not meet the target either. The [last failed baseline](phase10-load-before.json) preserves the full report. Query-plan inspection then exposed repeated planning overhead in the large snapshot projection; named prepared statements now reuse plans for snapshot and joined context reads without caching mutable world state. Ten real PostgreSQL gateway/replay/batching journeys pass; the native capacity rerun is pending. No callback durability, expected workload, retry policy or latency threshold is relaxed.

Client measurements are separate from server latency. Local Windows 11/i7-1260P/approximately 16 GB host evidence recorded input-to-next-frame p95 26.5 ms in Chrome and 64 ms in Edge, with 4x CPU emulation, one frame in flight and zero editing writes. Native Windows CI on `904fa4c` recorded 20.5/21.3 ms respectively. These tests use real inference on a licensed image, not a physical camera or universal low-end device claim. Slow automation transport is reported separately rather than counted as browser paint time.

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

The database tests/load harness require a PostgreSQL 18 administrative `TEST_DATABASE_URL` and create/drop only generated temporary fixture databases. The restore tool additionally verifies that this URL points to the Compose server before using its PostgreSQL client. Run browser suites serially with respect to each other to avoid sharing their fixture port/artifacts. Release packaging is last, after committing and exact-revision green CI. Final capacity results and phase exit are recorded below only after their gates pass.
