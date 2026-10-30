# Phase 9: judge tooling and measured policy evidence

Recorded 30 October 2026. This is synthetic development evidence, not live Twitch acceptance, an OBS capture, a capacity benchmark, or release readiness.

## Session and actual iteration

Principal Codex session: `01a18d83-decb-7e01-8cbe-e6c69963d4ab`. The user's task was to finish Phase 9 fully, without scaffolding or scope reduction, with passing repository CI while conserving their remaining weekly allowance. Three existing Phase 9 commits (whole-world replay, the replay CLI, and analytics) and unfinished sandbox routes were preserved and validated.

The initial sandbox journey returned HTTP 500 on Next scheduled step: PostgreSQL rejected `min(d.due_at)-w.clock_at` because the world clock was outside the aggregate. Aggregating the difference fixed it; the same full journey then passed, including studio appearance replay and reset.

Two further defects were reproduced against the actual earlier source revision `b88bc21`. The identical new PostgreSQL regressions were run after temporarily restoring only `game/sandbox.ts` and `routes/sandbox.ts` from that revision, then again after restoring the fixed sources. Temporary databases prevent either experiment from modifying the application world.

| Observation | Before | After (`b7e916f`) |
| --- | --- | --- |
| Same four synthetic accounts click different choices twice | 8 votes counted | 4; first valid vote stands |
| Two concurrent creations compete for one remaining slot | Both enter | One enters; one is rejected |
| Regression checks | 0 pass, 2 fail | 2 pass, 0 fail |

The change uses stable synthetic account keys and an advisory transaction lock around capacity counting and insertion. [Machine evidence](phase9-repair.json) retains the command, environment, source revisions, actual assertions, and failures. Run `npm run test:integration -- apps/server/src/routes/sandbox.integration.test.ts -t "one account|concurrent capacity"` to repeat the fixed checks. No game weights changed; the policy experiment below evaluates the existing frozen rules rather than claiming a balancing improvement from these fixes.

Browser verification found a separate real recovery defect: navigating between judge fragments on the same document did not load the new world. The page now handles fragment changes and clears stale state. A test selector also confused the SVG handle with the range input; the corrected test uses the exact accessible name and keyboard input, without bypassing editor behavior.

## Reproduce the balance experiment

From the repository root after `npm ci`:

```sh
npm run simulate -- --split tuning --rounds 36 --output docs/evidence/phase9-tuning.json
npm run simulate -- --split held-out --rounds 36 --output docs/evidence/phase9-held-out.json
```

The simulator needs no Twitch account, database, camera, or OpenAI key. The [tuning report](phase9-tuning.json) has 2,304 trials over eight seeds; the [held-out report](phase9-held-out.json) has 3,456 trials over twelve disjoint seeds. Each crosses six habitats, six policies, small/large normalized accounts, trace Keep/Clear, and shelter/conserve. Policies see only offered mutation cards and the previous known profile. No held-out seed was used to select a rule change. Each trial is rerun and its complete history hash compared; both reports have **zero divergences**. All 1,728 held-out small/large pairs have identical fitness-related results.

Reports include canonical rules, source revision, Node/OS environment, exact command, configuration/seed/result hashes, survival quantiles, terminal genes, arrival mortality, branch/cooldown bounds, trace costs, dormant offers/activations, habitat shape and matched ancestor fitness differences. The adversarial checks measure 1,000 repeated messages becoming twelve contributions from one limited-confidence account, 1,000 votes becoming one, a twelve-branch cap, nine immediate host-loop cooldown rejections, finite shelter transfer, and no lifetime renewal through migration or duplicate closes. Paid-event independence is tested in the real server integration suite; the simulator does not pretend that omitting payment inputs proves adapter independence.

## Observed held-out results

Survival at the 36-round horizon, small channel, trace Keep and conserve; each cell is living trials / 12. These are censored outcomes, not estimated mean lifetimes.

| Policy | Steady | Bursty | Shifting | Raid-heavy |
| --- | --- | --- | --- | --- |
| Always Pulse | 9 | 12 | 12 | 1 |
| Always Calm | 12 | 10 | 12 | 12 |
| Defensive | 12 | 10 | 12 | 12 |
| Migration-focused | 11 | 10 | 11 | 1 |
| Seeded random | 12 | 12 | 12 | 10 |
| Recent-profile-informed | 12 | 12 | 12 | 12 |

In this raid-heavy slice, arrival deaths (including first-comparison contest loss) are 59/59 for Pulse, 28/72 for Calm, 61/72 for defensive, 59/59 for migration-focused, 60/72 for random and 28/72 for profile-informed. This is a substantial pressure signal, not a reason to call candidate-1 final. Shifting-habitat dormant activations range from one for Calm/migration to seventeen for the informed policy. Trace fitness differences can be negative: upkeep and host acceptance matter, and geometry never contributes to fitness. Sparse rounds retain health because confidence is limited; they are excluded from the table and cannot establish a successful strategy.

The cohort model retains bounded successful children rather than simulating a complete population on every host. It checks child qualification and once-per-host trace emission, but is not an ecological equilibrium study. Only twelve evaluation seeds and a short horizon are available. Larger/longer studies and live behavior remain work for release validation; no unmeasured benefit or improvement percentage is claimed. Candidate-1 stays frozen with hash `8a0fcff558ef640ffdd61eea10ea5de3f29fc67d3b672564aa4f3da750bc59b4`.

## Studio and installed judge evidence

The simulator executes all six required studio scenarios: repeated break toggles cannot skip observation, pending reservations conflict, a minority-backed different-direction finalist is captured, committed appearance is inherited, restored duplicate commitment has one effect, and cosmetic hatches produce identical scores across 44 profile/trace combinations. PostgreSQL studio suites additionally cover actual ordered-worker restart, duplicate approvals/commits, dormant art, raids and accepted-record reconstruction.

[Installed browser evidence](phase9-installed-judge.json) records a **19,181 ms** journey against the production Compose application and PostgreSQL, with **zero intercepted requests**: landing, independent world, mutation, habitat observation, raid, pointer-built confirmed proposal, selection vote, approval, hatch, whole-world replay, lineage inspection and reset. The installed API smoke completed the same core journey in **8,023 ms**, comparing both channels with zero divergence. These times exclude first image download/build and human reading time; they measure the working judge path after one-command startup, not a usability study. CI repeats both journeys, and Windows Chrome/Edge tests cover camera/pointer editor behavior and browser recovery separately.

The live studio-to-raid rehearsal, real chat/raids, real OBS bridge/capture and hosted acceptance remain explicitly pending under the user's deferral. Phase 10 owns the remaining hardening and release work.
