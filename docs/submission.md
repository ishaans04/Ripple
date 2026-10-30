# Submission and release candidate

Ripple's source, migrations, pinned browser-local vision assets, tests and judge tools are in this repository. Start with [README](../README.md) and the [judge guide](judge-guide.md). A fresh local installation uses `docker compose up --build` and http://localhost:3000; no third-party credentials are needed to explore the labeled synthetic sandbox or local studio practice.

## Reviewable artifacts

- [Implementation plan](plan.md), [product specification](prd.md), [studio contract](cocoon-studio.md) and [delivery progress](progress.md).
- [Phase 9 balance, simulator, replay and actual Codex iteration evidence](evidence/phase9.md), including the principal session reference and limitations. Candidate-1 has not been advertised as a newly tuned winner.
- [Phase 10 validation and capacity evidence](evidence/phase10.md), with machine-readable load, restore and separate Chrome/Edge client reports. Failed baselines remain identified; no passing synthetic result is presented as live acceptance.
- [Recorded synthetic demonstration](demo/ripple-synthetic.webm), with persistent labeling of accelerated time and synthetic events. [Capture notes](demo/README.md) identify exactly what is shown and what authentic footage remains deferred.
- [Deployment](deployment.md), [operations/recovery](operations.md), [identity retention/deletion](privacy-operations.md), [Twitch setup and live rehearsal](twitch-setup.md), [environment example](../.env.example), and [third-party notices](../THIRD_PARTY_NOTICES.md).

## Package the exact validated source

After committing and obtaining green CI on the exact revision, run:

```sh
node tests/package-release.ts
```

The command refuses a dirty worktree, missing evidence, failed recorded latency/restore/client gates, insufficient Phase 10 history, the wrong author/committer, co-author trailers, forbidden archive paths, or a local revision without green CI. It creates a source ZIP and SHA-256 manifest under ignored `tmp/release/`. The archive comes from `git archive HEAD`; it includes the checked-in model and notices but excludes real environment files, database dumps, node_modules and local build output. The manifest records the exact revision and CI link. CI can also produce a candidate source artifact while its other jobs finish; that artifact alone is not final approval.

The synthetic fixture backup is deliberately excluded. Use `npm run test:restore` to reproduce the actual dump/restore exercise on a separate temporary database. Use `npm run test:judge`, `npm run simulate`, `npm run replay` and `npm run test:load` for the documented verification paths.

## Deferred acceptance and operator handoff

The user deferred accounts, public HTTPS and authentic Twitch/OBS acceptance. Before a real release, the operator must configure authorized broadcaster/bot grants and the stable domain, publish a contact and actual season/backup retention policy, verify hosted backup recovery and latency, and complete the two-channel studio-to-raid checklist in the Twitch guide. Capture genuine OBS readability, scene reconciliation/staleness, physical hand and pointer participation, chat selection, approval, hatch, raid inheritance and origin/ancestor inspection. Label replay or accelerated inserts. Replace or supplement the synthetic demonstration with those authentic segments; do not relabel synthetic footage as live.

The automated low-resource client test uses a real pinned model in installed Windows Chrome/Edge, a licensed test image and 4x CPU throttling. It is not a universal physical-camera/GPU compatibility claim. Verify the intended broadcaster laptop, camera permission, actual lighting and OBS browser-source behavior during that same setup rehearsal. Pointer controls remain fully functional without a camera.

Final live acceptance and any competition eligibility/submission-period declarations require the operator's actual evidence. No paid service, public deployment, release tag or external submission is created automatically by the packaging command.
