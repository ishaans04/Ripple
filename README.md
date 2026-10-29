# Ripple

Ripple is a Twitch-connected, deterministic evolution game shared by streamers and their communities. Chat makes bounded mutation decisions, the channel's observed activity creates selection pressure, and a real raid branches a descendant into another channel, where the receiving community shapes its next adaptation.

> Communities shape living strains. Raids carry their descendants. Every host changes the lineage, and successful visitors leave a trace for those who follow.

The full specification is in [docs/prd.md](docs/prd.md), extended by the [Cocoon Studio addendum](docs/cocoon-studio.md), and the phased delivery plan is in [docs/plan.md](docs/plan.md).

## Current status

Ripple is being built phase by phase. **Phases 0–6 implementation is complete: foundation, pure engine, studio rules and local editor, event backbone, Twitch live loop, raids/lineage, and novel mechanics. Real Twitch/hosted acceptance remains pending.** What works today:

The [Cocoon Studio practice](http://localhost:3000/studio) provides a complete local shell editor with hand, pointer, touch, and keyboard controls. Ordered durable intake, round processing, transactional history and public updates, leased deadlines, process-gap recovery, scoped WebSockets, and synthetic command tooling are implemented. Habitat traces, dormant possibilities, saved ancestor/alternative comparisons and recent-profile previews are connected to gameplay and scoped presentation. **Phase 7, product surfaces, is in progress.** Its dedicated OBS overlay and controller link are implemented. Verification and pending live acceptance are recorded in [delivery progress](docs/progress.md).

- The application service (Fastify on Node.js 24) with structured, correlated JSON logs, a uniform error contract, security headers, and graceful shutdown
- PostgreSQL 18 with versioned migrations under an advisory lock, world-scoped game records, immutable ancestry/rules, and database-enforced genome bounds
- Liveness and readiness endpoints (`/health/live`, `/health/ready`)
- The web landing page, served by the same service, showing live service status
- One-command local startup with Docker Compose, and CI covering lint, types, unit tests, integration tests on real PostgreSQL, the build, and a Compose smoke test
- The deterministic game rules as a tested library (`@ripple/engine`; see [Game engine](#game-engine)), reproducing the PRD's worked journey (section 25.4) exactly

The engine processes persisted rounds with synthetic inputs. The configured Twitch adapter supports broadcaster/operator OAuth, encrypted grants, signed EventSub intake, subscription reconciliation, local chat voting/activity, stream recovery and bounded bot output. `/controller` provides connection steps, named seeding, pause/recovery, visitor policy, novel-mechanic settings and read-only preview links. These integrations pass provider-fixture and PostgreSQL checks; **no real Twitch or hosted acceptance is claimed**. The full broadcast surfaces, connected Studio and judge sandbox remain in the [plan](docs/plan.md).

The propagation backend supports bounded descendants, destination admission, preparation/welcome ballots, matched observations, shelter, contests and FIFO harbor behavior. Outgoing `channel.raid` notifications enter through signed, deduplicated EventSub receipts; viewer counts confer no game power. Owning broadcaster sessions can enqueue preparation, approve/refuse visitors and block source channels or lineages through the controller, with CSRF, an idempotency key, channel version and transfer version checks. Block lists are paginated and support unblocking. The controller and read-only preview show bounded visitor origin/generation, lineage counts, held admissions, standing preparation and the last contest; controls wait for the worker's committed result. Phase 5 application acceptance passes in CI; no real raid evidence is claimed.

New raids to an unenrolled destination can retain one inactive descendant under the normal lineage cap and pair cooldown. The source controller provides a user-copied invitation; only the original destination can request historical adoption after connecting Twitch. The captured genes, appearance, energy and original expiry are preserved. The controller labels the earlier raid and distinguishes activation, holds and refusals. Unclaimed descendants expire without simulation decay. Older accepted attempts that retained no child stay unchanged; adoption never invents offspring for those records.

### Twitch setup

Open `/controller` to inspect connection readiness and manage your channel on a configured HTTPS deployment. Live integration is disabled by default; local practice stays available without secrets. Follow the [Twitch and Railway setup guide](docs/twitch-setup.md) for accounts, exact redirect URLs, independent secret keys, operator bot authorization and the pending live acceptance journey. A successful OAuth redirect alone does not establish subscription readiness.

## Quick start

Requirements: Docker with Compose v2 (tested with Docker 29 and Compose 5 on Windows 11).

```sh
git clone https://github.com/ishaans04/Ripple.git
cd Ripple
docker compose up --build
```

Open http://localhost:3000. No Twitch or other third-party credentials are needed.

Compose starts PostgreSQL, waits for it to become healthy, applies migrations once in a dedicated step, then starts the app. Stop it with `Ctrl+C` or `docker compose down`; add `--volumes` to delete the database.

### Troubleshooting

- **Port 3000 or 55432 is already in use:** stop the other process, or change the published port in `compose.yaml`.
- **The page reports that the service cannot reach its database:** run `docker compose ps` and check that `db` is healthy and `migrate` exited with code 0. Use `docker compose logs migrate app` for details.
- **Stale image after pulling new code:** rerun with `--build`.

## Local development

Requirements: Node.js 24 LTS (see `.nvmrc`) and Docker for PostgreSQL.

```sh
npm ci
cp .env.example .env
npm run db:up          # PostgreSQL 18 on localhost:55432
npm run db:migrate
npm run dev -w @ripple/server   # API on http://localhost:3000
npm run dev -w @ripple/web      # web app on http://localhost:5173 (proxies the API)
```

Sources run directly on Node's TypeScript type stripping; workspace packages resolve to their sources through the `ripple-source` export condition, and `npm run build` emits JavaScript for production.

| Script                                    | Purpose                                                               |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `npm run lint`                            | ESLint with strict type-aware rules                                   |
| `npm run format` / `format:check`         | Prettier                                                              |
| `npm run typecheck`                       | TypeScript across the root and every workspace                        |
| `npm test`                                | Unit tests                                                            |
| `npm run test:integration`                | Integration tests against real PostgreSQL (`TEST_DATABASE_URL`)       |
| `npm run build`                           | Compile packages and the server; bundle the web app                   |
| `npm run db:up` / `db:migrate`            | Start PostgreSQL / apply migrations                                   |
| `npm run db:generate -w @ripple/database` | Generate a migration from schema changes                              |
| `npm run sandbox -- ...`                  | Run the isolated synthetic game adapter                               |
| `npm run smoke:game`                      | Verify a synthetic round, HTTP snapshot, and WebSocket                |
| `npm run smoke:raids`                     | Verify a two-channel synthetic preparation, raid, welcome and contest |
| `npm run smoke:mechanics`                 | Verify earned mechanics, inherited expiry and scoped saved analysis   |

## Configuration

The server reads these environment variables (see [.env.example](.env.example)):

| Variable            | Default            | Meaning                                                         |
| ------------------- | ------------------ | --------------------------------------------------------------- |
| `DATABASE_URL`      | required           | PostgreSQL connection string                                    |
| `HOST` / `PORT`     | `0.0.0.0` / `3000` | Listener address                                                |
| `LOG_LEVEL`         | `info`             | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `SHUTDOWN_GRACE_MS` | `15000`            | Time to drain requests before forcing exit                      |
| `WEB_ROOT`          | unset              | Built web app directory to serve; the Docker image sets it      |

Invalid configuration stops startup with a message naming each offending variable, without echoing values.

## Synthetic round loop

After migrations, run `npm run sandbox -- create`. This creates and seeds an independent, clearly labeled synthetic world, returning its IDs, private owner capability, read-only capability, and snapshot. It expires after 24 hours. Keep the capabilities private. The complete judge interface arrives in Phase 9; this command adapter exercises the real engine, transactions, inbox, and deadline jobs today.

For PowerShell, set `$env:RIPPLE_SANDBOX_CAPABILITY` to the returned owner capability, then substitute the returned world and channel IDs:

```powershell
npm run sandbox -- vote WORLD_ID CHANNEL_ID alice 2
npm run sandbox -- advance WORLD_ID CHANNEL_ID 3200
npm run sandbox -- activity WORLD_ID CHANNEL_ID alice
npm run sandbox -- activity WORLD_ID CHANNEL_ID bob
npm run sandbox -- activity WORLD_ID CHANNEL_ID carol
npm run sandbox -- advance WORLD_ID CHANNEL_ID 12000
npm run sandbox -- status WORLD_ID CHANNEL_ID
```

The stored synthetic timings are 3 seconds voting, 200 milliseconds acceptance grace, 12 seconds observation, and 800 milliseconds reveal. An advance runs the actual persisted cutoffs in order. Each advance accepts 1–300,000 milliseconds and returns its operation UUID; supplying that UUID after the milliseconds retries the same step without advancing twice. A bounded run reports `pending` explicitly; retry that operation to continue. Live worlds reject synthetic clocks and commands on the server.

`pause`, `resume`, `offline`, `online`, `input-outage`, and `recover` take the same world/channel arguments. Clean pauses retain active time. Returning online requires an explicit resume; an input outage requires healthy integration followed by explicit recovery and a fresh observation. Limited-confidence complete rounds permit mutations but hold energy.

`peer WORLD SOURCE "Receiver" [PEER_UUID]` adds an empty receiving channel in the same synthetic world and returns its channel ID and scoped read capability. Supply the same peer UUID and label to retry creation; a world holds at most eight channels. The owner's existing capability controls every channel in that world. Use `seed WORLD PEER` to give it a resident, or leave it empty for a two-choice welcome. `advance` moves the shared world clock and processes every peer, while leaving other worlds untouched.

```powershell
npm run sandbox -- peer WORLD_ID SOURCE_ID "Receiver" PEER_UUID
npm run sandbox -- policy WORLD_ID PEER_ID accept
npm run sandbox -- prepare WORLD_ID SOURCE_ID
npm run sandbox -- raid WORLD_ID SOURCE_ID PEER_ID RECEIPT_UUID
```

Substitute actual UUIDs; `PEER_ID` is the channel ID returned by `peer`. Reusing the raid receipt UUID returns the existing result. Preparation waits for a safe ballot and the raid uses its last committed choice. `policy` accepts `ask`, `accept` or `reject`; `admit`/`decline` take `WORLD CHANNEL TRANSFER VERSION`; `block-source`/`block-lineage` take `WORLD CHANNEL ID true/false`. Command output distinguishes durable acceptance, the current snapshot and whether settlement still has pending work. This is the command adapter; the complete judge interface remains Phase 9.

New CLI worlds use mechanics version one. `enable-mechanics WORLD CHANNEL` requests the safe-boundary upgrade for an older world; `clear-traces WORLD CHANNEL` and `traces WORLD CHANNEL true/false` record the same real clear/preference transitions as owner controls. These commands cannot control live channels. Trace decisions still use ordinary synthetic chat votes: 1 Keep, 2 Clear, with no votes defaulting to Clear.

To exercise historical adoption, choose a fresh destination UUID, run `raid-unknown WORLD SOURCE FUTURE_PEER_UUID [RECEIPT_UUID]`, then create `peer WORLD SOURCE "Later receiver" FUTURE_PEER_UUID`. Find the retained transfer ID/version in the source snapshot's outgoing raids and run `claim WORLD FUTURE_PEER_UUID TRANSFER_ID VERSION`. Claiming keeps the original invitation deadline, respects admission holds and uses the already reserved child. The CLI cannot exercise a live-world claim.

Read access uses `GET /api/worlds/WORLD_ID/snapshot?channelId=CHANNEL_ID` with `Authorization: Bearer READ_CAPABILITY`. `POST /api/overlay/exchange` accepts `{ "worldId": "...", "channelId": "..." }` with the same header and returns a single-use, 30-second ticket for `/api/live?ticket=...`. WebSockets start with a current snapshot, carry complete versioned projections, reject client writes, cap buffers, check authority again, and repair missed updates from PostgreSQL independently in each gateway. Vote aggregates are limited to twice per second. These endpoints accept scoped read authority, never browser impersonation of live Twitch voters.

With the stack running, `docker compose exec -T app node apps/server/dist/cli/smoke-game.js` verifies the installed command tool, a real three-account resolution, the scoped HTTP snapshot, and a snapshot-first WebSocket. It prints a public result summary and keeps generated capabilities out of its output. CI runs this journey inside the production image. For source development, `npm run smoke:game` uses the database environment and the running app at localhost:3000; set `RIPPLE_SMOKE_URL` for another app URL.

`docker compose exec -T app node apps/server/dist/cli/smoke-raids.js` verifies two synthetic channels, standing Shield, duplicate raid receipts, a preserved open ballot, welcome, finite Shelter, matched contest, a fossil, the retained source parent and the receiving channel's scoped HTTP snapshot. It also checks an unenrolled raid followed by historical adoption, preserving the captured child and original expiry. CI runs this installed tool too. For source development use `npm run smoke:raids`.

`docker compose exec -T app node apps/server/dist/cli/smoke-mechanics.js` verifies version-one creation, minority capture and exact inherited allowance, actual saved ancestor/rejected-choice records, a trace earned through two real synthetic observations, Keep, pause preservation, three-valid-observation expiry, capability-scoped analysis and immutable attribution after expiry/toggling. CI runs it in the production image; source development uses `npm run smoke:mechanics`. All three tools are synthetic verification and never establish live Twitch or OBS acceptance.

## Repository layout

```text
apps/server/         Fastify application service: config, logging, health, web serving
apps/web/            React + Vite browser app: design tokens and landing page
packages/contracts/  Zod schemas shared by the server and browser
packages/engine/     Pure deterministic game rules: genomes, ballots, habitats, scoring, explanations
packages/database/   Drizzle schema, SQL migrations, migration runner
docs/                PRD, Cocoon Studio addendum, delivery plan, and archived design history
```

## Game engine

`@ripple/engine` holds the game rules as pure functions. It performs no I/O and never reads the clock or ambient randomness, so the same recorded inputs always produce the same result in Node or the browser.

| Area          | What it does                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integers      | Safe-integer arithmetic only; floor division and round-half-up are explicit, never floating point                                                                                                   |
| Rulesets      | Versioned, deeply frozen balance parameters, identified by the SHA-256 of their canonical JSON (RFC 8785, integers only). `candidate-1` holds the PRD's initial, still unvalidated values           |
| Randomness    | xoshiro128\*\* seeded from SHA-256 of recorded material; unbiased bounded draws; Fisher-Yates shuffle                                                                                               |
| Genomes       | Pulse, Calm, Grit, Drift in [0, 15] summing to 24; a mutation moves 2 points between two genes                                                                                                      |
| Ballots       | Three distinct cards from a seeded shuffle of the sorted legal moves; each account's first valid vote stands; ties go to seeded order; no votes means Hold                                          |
| Habitat       | Burst and steadiness (0-1000) from chat, with one contribution per account per 10-second bucket; confidence needs three accounts; frozen baselines from the last ten valid rounds give context only |
| Scoring       | The PRD 6.5 integer fitness contract with Grit protection, capped shock, one capped trace, delta and health clamps, and extinction at zero                                                          |
| Resolution    | Applied, limited (estimate with health held), or interrupted (nothing progresses; never treated as a quiet round)                                                                                   |
| Explanations  | Deterministic templates: every signed contribution sums to the energy change, at most two leading causes, and the full calculation                                                                  |
| Journey rules | Raid child health from Drift, dormant capture and offer checks, trace template and qualification, and ancestor trials under matched inputs                                                          |

The ordered round scheduler persists ballots, observation, reveal, and recovery checkpoints. Admission, shelter, contests and fossils are persisted. Phase 6 adds pure, bounded valid-observation lifetime helpers and database constraints against lifetime renewal, provenance edits and terminal revival. Each world pins an immutable mechanics policy; channel genesis preserves the legacy/new distinction. New live enrollment and synthetic CLI creation record mechanics version one. Existing channels retain their original genesis and behavior until their owner requests **Enable novel mechanics**; the ordered worker applies that request only at the next healthy, unpaused round opening. Current ballots and observations retain their original mechanics. Reauthorization never upgrades a legacy channel implicitly.

Version-one sessions capture qualified minority-backed losing directions using aggregate counts and explicit replacement history. Their allowance excludes capture, limited data, pauses and interruptions, expires after three later valid observations, and reconstructs from accepted inputs. Captures without a prior valid profile retain that unknown provenance and cannot infer a trigger from later data. A suitable known profile permits one legally rebased, labeled offer in a normal three-card ballot; selection or rejection consumes it. Raid children snapshot the remaining allowance, counted rounds and prior offer state, including held historical invitations; parent activity and later adoption never renew them. Inherited allowances also expire during valid observations in legacy hosts, even though those hosts cannot capture or offer dormant cards until enablement.

The engine also evaluates rejected mutation cards against fixed recorded start energy, profile, shocks and trace, recomputing gene effects and final energy clamps. Mechanics-version-one sessions persist immutable comparisons of the recorded ballot, including no-vote Hold and explicitly estimated limited-data results. Reconstruction includes those records; no downstream branches change. The scoped read API, snapshots, controller and read-only preview return those saved comparisons. Actual results, ancestral shadows and rejected-choice models have separate text labels and visual treatments, with full recorded calculation details.

Mechanics-version-one sessions persist ancestor trials against the lineage's founding genome using captured start energy, profile and raw shock markers. Trials are immutable, retain engine/rules identity, and compare scores before any finite Shelter settlement. Limited/interrupted intervals create no trial. `GET /api/rounds/:id/explanation?worldId=…&channelId=…` requires the channel's read capability and returns saved participant scores, explanations, ancestor/alternative comparisons, settlement and immutable trace attribution. Unresolved rounds return an explicit conflict; cancelled trace decisions contain no invented scores. Historical rounds remain readable without fabricating comparisons they never recorded. The controller labels equal genomes and insufficient data explicitly, and separates scored energy from subsequent Shelter settlement.

Version-one raid-origin survivors can earn one trace per lineage/host after two valid destination observations. Recorded two-choice Keep/Clear ballots default to Clear; Keep activates one shared host modifier and explicitly replaces any prior trace. All three templates, pending/active expiry, matched resident/visitor scoring and preserved attribution are implemented. Activation requires an earned database qualification and the recorded Keep ballot. Versioned owner controls clear or disable traces, explicitly cancel open trace decisions, preserve resolved scores and prevent re-enabling discarded offers.

Scoped snapshots, the controller and read-only preview show earned active/pending traces, benefits and costs from the frozen channel rules, remaining valid observations, lineage/origin attribution and the eight most recent terminal trace records. Dormant summaries show aggregate support, directional trade-off, original channel, inherited allowance and whether the single offer has already been used. These records expose no voter identities and grant no hidden gameplay effects. Historical round analysis retains its own trace attribution after recent history rolls off.

Mutation-preview rules use only a recorded recent valid profile and a known trace, label their uncertainty, and return Learning when no valid profile exists. Version-one ballots freeze the preview at opening, retain its source round, and expose estimates and trade-offs in the controller/read-only preview. New observations never rewrite the displayed estimate.

## Lineage reads

`GET /api/lineages/:id?worldId=…&channelId=…` uses the channel's read capability to return approved origin/branch names, parent/founder/generation, saved genome/appearance/energy/status, current or last ended host, birth/admission provenance, branch counts and earned trace attribution after expiry. Access is limited to that world's lineages the channel originated or encountered; it does not expose unrelated lineages, voter identities, raw transfer snapshots or unenrolled destination identities.

Pages default to 25 branches, with `limit` from 1–50. Pass the returned `next` as `after` to continue in generation/ID order. Each page uses one committed database snapshot; refresh from the first page to include newly born branches. Historical fossils preserve their actual saved appearance and energy, including contest losses above zero. The full passport and lineage UI remain Phase 7 work.

## Broadcast overlay

Create or rotate a read-only preview link in `/controller`; the same operation now provides an **OBS browser source URL** for `/overlay`. Paste it into a 1920×1080 browser source. The canvas is transparent, with the creature and a compact decision panel in the lower corner. Both links share one scoped capability; rotation revokes both. Capabilities remain in URL fragments and authorized headers, never ordinary page-query parameters. Overlay links cannot send owner controls or votes.

The overlay displays actual energy, numbered choices/trade-offs, aggregate votes, server-aligned close time, trace costs/origin, dormant indicators, visitors, results and explicit pause/offline/interrupted states. Reconnecting retains the last confirmed creature while suppressing stale vote invitations; closed ballots await server confirmation. Synthetic/replay modes have persistent text labels. Chrome/Edge browser checks cover transparency, narrow layouts, capability scope, reconnection and the existing detailed preview. A real OBS capture and expanded display preferences remain Phase 7 acceptance work; browser screenshots do not establish OBS readability.

## Cocoon Studio practice

Start the app normally and open `/studio`, or follow the practice studio link on the landing page. Choose a legal shell trade-off, drag the white control points or use the labeled sliders, and choose a marking and palette. Undo, redo, reset, local draft recovery, and a confirmed JSON download work without an account or Twitch credentials. Local practice never submits a live proposal or changes live game state.

Hand controls are opt-in. Enable the camera, face your palm toward it, pinch a white control point, move, then release. Calibration includes a mirrored preview, hand detection, sensitivity, and one-hand mode; disable one-hand mode to scale with two pinching hands. Tracking loss freezes editing and never saves or submits. Camera or model failure keeps the draft and leaves all pointer controls usable. Video and landmarks stay in the browser; the microphone is never requested. Camera tracks stop when disabled or when leaving the studio, and inference pauses in hidden tabs.

The pinned MediaPipe 1.1.1 runtime and SHA-256-verified version 1 model are served by Ripple, with inference in a module worker. `npm run build` and the web dev script prepare the package's local WASM assets. See [third-party notices](THIRD_PARTY_NOTICES.md). Production camera access requires HTTPS; localhost works for development.

`npm run test:e2e` builds the application and runs the studio browser journeys against the actual Fastify service and production security headers. Windows Chrome and Edge must be installed. Tests include real model inference on an upstream test photograph (no physical camera needed), synthetic-landmark parity with pointer input, denial, tracking loss, touch dragging, and local recovery. These tests are not a claim of live Twitch integration.

The browser suite starts its own server on port 4179 and refuses to reuse an existing listener. Set `RIPPLE_E2E_PORT` to another free port when needed; unrelated local previews cannot supply a passing server check. Raw touch checks scroll the target into view and verify its hit target before dispatch.

## Architecture

One TypeScript application service plus PostgreSQL, deployed as a single image (see PRD section 12). Browsers never connect to the database. The same image runs locally under Compose and in hosted deployments, with migrations applied as a separate pre-start step.
