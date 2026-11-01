<div align="center">

# Ripple

**A Twitch evolution game where chat steers mutations, live channel activity drives natural selection, and raids carry descendants into new communities.**

[![CI](https://github.com/ishaans04/Ripple/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ishaans04/Ripple/actions/workflows/ci.yml)
![Status: release candidate](https://img.shields.io/badge/status-release_candidate-d4f25a?style=flat-square)
![Live Twitch acceptance: pending](https://img.shields.io/badge/live_Twitch_acceptance-pending-9146FF?style=flat-square&logo=twitch&logoColor=white)
![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24_LTS-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript 6](https://img.shields.io/badge/TypeScript-6.0_strict-3178C6?style=flat-square&logo=typescript&logoColor=white)

![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)
![Vite 8](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)
![Fastify 5](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)
![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-0.45-C5F74F?style=flat-square&logo=drizzle&logoColor=black)
![Zod 4](https://img.shields.io/badge/Zod-4-3E67B1?style=flat-square&logo=zod&logoColor=white)
![MediaPipe](https://img.shields.io/badge/MediaPipe-hand_tracking-0097A7?style=flat-square&logo=mediapipe&logoColor=white)
![Twitch EventSub](https://img.shields.io/badge/Twitch-EventSub-9146FF?style=flat-square&logo=twitch&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-Chrome_%2B_Edge-2EAD33?style=flat-square)
![Vitest](https://img.shields.io/badge/Vitest-5-6E9F18?style=flat-square&logo=vitest&logoColor=white)

[Quick start](#quick-start) · [How it plays](#how-it-plays) · [Architecture](#architecture) · [Testing](#testing-and-quality) · [Documentation](#documentation) · [Judge guide](docs/judge-guide.md)

</div>

<p align="center">
  <img src="docs/images/ripple-landing.png" alt="Ripple landing page: the Ripple wordmark beside a teal founding-strain creature, with Enter the console and Try a three-minute expedition actions" width="100%">
</p>

**Ripple** is a deterministic, chat-driven evolution game for Twitch streamers and their communities. Viewers vote in chat (`!ripple 1`, `2` or `3`) on bounded genetic mutations, the stream's real chat activity becomes the habitat that scores each strain's fitness, and an actual Twitch raid branches a descendant into another channel, where a new community decides how it adapts. Between rounds, viewers can design the creature's shell in **Cocoon Studio** with a mouse, touch or in-browser **MediaPipe hand tracking**.

Every outcome is reproducible: a pure TypeScript game engine turns checksum-chained accepted records into the same lineage every time, so an entire world can be exported, replayed and verified. Ripple ships as one Fastify service plus PostgreSQL, with signed Twitch EventSub intake, snapshot-first WebSockets, a transparent OBS overlay, a broadcaster console and a keyless judge sandbox.

> [!NOTE]
> **Release candidate.** All implementation phases are complete and verified in CI. Real Twitch, OBS and hosted acceptance has not been performed yet: it needs authorized broadcaster and bot accounts and a public HTTPS URL. Everything you can run locally is real application code against PostgreSQL, and synthetic worlds are always labelled as such. See [Project status](#project-status).

<details>
<summary><strong>Table of contents</strong></summary>

- [Highlights](#highlights)
- [How it plays](#how-it-plays)
- [Product surfaces](#product-surfaces)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Testing and quality](#testing-and-quality)
- [Determinism and replay](#determinism-and-replay)
- [Security and privacy](#security-and-privacy)
- [Twitch integration](#twitch-integration)
- [Deployment and operations](#deployment-and-operations)
- [Command-line tools](#command-line-tools)
- [HTTP and real-time API](#http-and-real-time-api)
- [Repository layout](#repository-layout)
- [Project status](#project-status)
- [Documentation](#documentation)
- [Acknowledgements and license](#acknowledgements-and-license)

</details>

## Highlights

- **Chat-steered evolution.** Each ballot offers three legal mutation cards. Every account's first valid vote stands, ties fall to a seeded order, and no votes means Hold.
- **The stream is the habitat.** Burst and steadiness are measured from chat activity, one contribution per account per 10-second bucket. Viewer counts and payments never buy game power.
- **Raids that branch lineages.** A raid sends one descendant; the parent always stays home. The receiving community can prepare, welcome, shelter or contest it, and overflow waits in a first-in, first-out harbor.
- **Mechanics with memory.** Habitat traces left by successful visitors, dormant minority-backed mutations, live ancestor trials and plain-language explanations of every energy change.
- **Cocoon Studio.** During a break, the community designs the creature's shell, chat picks among at most two finalists, the broadcaster approves, and the design hatches at the next mutation slot and travels with future raids.
- **Deterministic and replayable.** Integer-only rules, seeded randomness and checksum-chained records rebuild any world exactly, with a channel-by-channel equality check.
- **Built for broadcasts.** A transparent 1920×1080 OBS overlay, reduced-motion support, no sound, and accessibility checks in every browser journey.
- **Private by design.** Camera frames and hand landmarks never leave the browser, analytics carry no viewer identities, and artist identities can be erased without breaking replay.
- **Judge-ready.** A keyless, isolated sandbox world with a neighbor channel covers the whole loop, studio included, in about three minutes.

## How it plays

The central loop is **seed → choose → observe → adapt → raid → welcome → inherit → leave a trace**.

```text
 HOME CHANNEL        seed ──► choose ──► observe ──► adapt ──┬──► next round
                              !ripple    chat as             │
                              1, 2, 3    habitat             │ raid: one descendant
                                                             ▼ carries its history
 RECEIVING CHANNEL   welcome ──► inherit ──► adapt ──► leave a trace
```

1. **Seed.** A broadcaster names a founding strain. Its genome has four genes, **Pulse**, **Calm**, **Grit** and **Drift**, each from 0 to 15 and always summing to 24.
2. **Choose.** Chat votes on three mutation cards drawn from a seeded shuffle of the legal moves. A mutation moves two points between two genes.
3. **Observe.** For a fixed window, Ripple measures the channel's burst and steadiness (0–1000). Confident observations need at least three distinct accounts; otherwise the round is labelled limited and health is held.
4. **Adapt.** An integer fitness contract scores the genome against the habitat, with Grit protection, capped shocks and clamps. The result explains every signed contribution and its two leading causes. Energy at zero means extinction.
5. **Raid.** When the streamer raids, one descendant branches into the destination channel with health derived from Drift. Destinations choose an admission policy (ask, accept or reject) and can block source channels or lineages.
6. **Welcome.** The receiving community votes on a welcome choice, may grant finite shelter, and resolves contests against its incumbent under matched conditions. Losers become fossils that keep their final appearance.
7. **Inherit.** Children carry their genome, committed shell design, appearance mapping and origin marks, so every creature shows where its lineage has been.
8. **Leave a trace.** A raid-origin survivor that thrives through two valid observations can earn a habitat trace. The host chooses Keep or Clear (Clear by default), and a kept trace changes the habitat for later residents and visitors until it expires.

<details>
<summary><strong>The deeper mechanics</strong></summary>

| Mechanic          | What it does                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dormant mutations | A losing direction backed by a qualified minority is captured. It can return once as a labelled, legally rebased card while its allowance lasts (three later valid observations), and raid children inherit it. |
| Ancestor trials   | Each resolved round also scores the lineage's founding genome against the same recorded inputs, so chat can see whether evolution actually helped.                                                              |
| Rejected choices  | The cards chat did not pick are evaluated against the same recorded start energy, habitat and shocks, and saved as clearly labelled comparisons.                                                                |
| Mutation previews | Estimates use only a recorded recent profile and are frozen when a ballot opens; with no valid history they say "Learning" instead of guessing.                                                                 |
| Resolution states | Applied, limited (an estimate with health held) or interrupted (nothing progresses, and it is never treated as a quiet round).                                                                                  |
| Family updates    | Births, admissions, fossils and earned traces are appended to a per-lineage log. When a channel comes back online it sees up to three updates from relatives elsewhere.                                         |
| Celebrations      | Optional cheers, subscriptions and hype trains show an eight-second thank-you labelled "Celebration only · no game advantage". The payer and the amount are never read or stored.                               |

Every mechanic is versioned. A world pins its mechanics policy, and existing channels keep their behavior until the owner explicitly enables a newer version at a safe round boundary.

</details>

### Cocoon Studio

Cocoon Studio turns a stream break into a community design session:

1. A break opens the studio, manually from the console or automatically from a configured OBS scene through the OBS bridge. The game clock pauses at its checkpoint.
2. Only currently legal shell trade-offs are offered (Grit +2 against Pulse, Calm or Drift −2), or a labelled appearance-only option.
3. Anyone can sculpt locally; artists sign in with Twitch for identity only, with no scopes. Drafts never reach the server until the artist confirms one bounded, declarative blueprint.
4. When creation closes, a recorded seeded draw picks at most two finalists. **Keep current** is always offered, is the no-vote default and wins ties.
5. The broadcaster approves or keeps the current shell, or restricted templates are approved automatically. An approved design waits as a visible cocoon and hatches at the next mutation slot in one transaction.
6. Raid children inherit committed designs. Passports credit the studio, the creating channel and, only when they opt in, the artist.

Hand tracking is optional and runs entirely in the browser: pinch a white control point, move, release. Losing tracking freezes editing and never saves or submits, and pointer, touch and keyboard controls offer the same choices.

## Product surfaces

| Route         | Audience                | What it is                                                                                                                                   |
| ------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | Everyone                | Scroll-told introduction to the loop, with live service status                                                                               |
| `/sandbox`    | Judges and visitors     | Keyless synthetic expedition: home and neighbor channels, accelerated clock, studio, replay and reset                                        |
| `/studio`     | Viewers and artists     | Cocoon Studio: local practice with draft recovery and JSON download, or a live studio from a studio link                                     |
| `/controller` | Broadcasters            | The console: Twitch connection, seeding, pause and recovery, visitor policy and blocks, mechanics, studio settings, display options, metrics |
| `/overlay`    | OBS browser source      | Transparent 1920×1080 creature and decision panel with server-aligned countdowns and explicit paused, offline and interrupted states         |
| `/preview`    | Moderators and partners | Read-only detailed view of the channel's game, from a revocable link                                                                         |
| `/lineage`    | Communities             | Lineage map with collapsible family trees, fossils and traces, plus each branch's passport                                                   |
| `/bridge`     | OBS browser source      | Reports scene changes and heartbeats so breaks can open the studio automatically                                                             |
| `/privacy`    | Everyone                | Camera locality, retention, deletion and the effect of erasure on accepted designs                                                           |

## Architecture

Ripple is one TypeScript application service plus PostgreSQL, deployed as a single image. Browsers never talk to the database, and hand-tracking inference runs in the viewer's browser, so no GPU or vision backend is needed.

```text
   Twitch: OAuth, EventSub webhooks, chat                     Browsers
                  │                                            /overlay  /controller  /studio
                  │ HMAC-verified, deduplicated receipts       /sandbox  /lineage     /preview
                  ▼                                                │ HTTPS and WebSockets
 ┌────────────────────────────────────────────────────────────────┴──────────────────┐
 │ Fastify service (Node.js 24)                                                      │
 │                                                                                   │
 │  intake ──► durable inbox ──► ordered worker ──► @ripple/engine (pure rules)      │
 │  owner controls: CSRF,         leased deadlines,    no I/O, no clock,             │
 │  idempotency keys,             sorted locks,        no ambient randomness         │
 │  version checks                up to 32 channels                                  │
 │                                in parallel ──► outbox ──► gateways (WebSockets)   │
 └───────────────────────────────────────┬───────────────────────────────────────────┘
                                         ▼
 PostgreSQL 18: world-scoped state · checksum-chained accepted records · immutable ancestry
                and rules · receipts and idempotency · per-lineage family log
```

- **Ordered, durable processing.** Every input is persisted before it is acknowledged. A per-channel ordered worker applies inputs under sorted transaction locks, so both sides of a raid stay consistent, and recovers cleanly after crashes or process gaps.
- **A pure engine.** `@ripple/engine` performs no I/O and never reads the clock or ambient randomness. It uses safe-integer arithmetic, versioned rulesets identified by the SHA-256 of their canonical JSON (RFC 8785), and seeded xoshiro128\*\* randomness, so the same inputs give the same result in Node or the browser.
- **Transactional publishing.** Public updates and bot messages are committed with the game change that caused them, then delivered. WebSockets start with a current snapshot, carry complete versioned projections, reject client writes and repair missed updates from PostgreSQL.
- **World isolation.** Every record belongs to one world. Sandbox, replay and live worlds never mix, and synthetic clocks and commands are rejected for live worlds on the server.
- **Scoped access.** Read capabilities are hashed at rest, travel in URL fragments or `Authorization` headers, and exchange for single-use, 30-second WebSocket tickets.

## Tech stack

| Layer       | Technology                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Language    | TypeScript 6 in strict mode; sources run directly on Node.js 24 type stripping during development                   |
| Server      | Fastify 5 with `@fastify/websocket`, `@fastify/helmet`, `@fastify/rate-limit` and `@fastify/static`; `pg`; `ws`     |
| Data        | PostgreSQL 18; Drizzle ORM schema with versioned SQL migrations applied under an advisory lock                      |
| Contracts   | Zod 4 schemas shared by the server and the browser                                                                  |
| Game engine | Pure TypeScript with `@noble/hashes`, canonical JSON and seeded xoshiro128\*\*                                      |
| Web         | React 19, Vite 8 and CSS Modules; self-hosted Fraunces, Bricolage Grotesque and JetBrains Mono                      |
| Vision      | MediaPipe Tasks Vision 1.1.1 in a module worker, with a pinned, SHA-256-verified hand landmarker model              |
| Testing     | Vitest 5 with fast-check property tests, real-PostgreSQL integration tests, Playwright in Chrome and Edge, axe-core |
| Quality     | ESLint 10 with type-aware rules, Prettier 3, dependency-notice checks                                               |
| Delivery    | Multi-stage Docker image pinned by digest, Docker Compose, GitHub Actions and Railway                               |

## Quick start

**Requirements:** Docker with Compose v2.

```sh
git clone https://github.com/ishaans04/Ripple.git
cd Ripple
docker compose up --build
```

Open <http://localhost:3000> and choose **Try a three-minute expedition**. No Twitch account, credentials or camera are needed.

Compose starts PostgreSQL, waits for it to become healthy, applies migrations once in a dedicated step, then starts the app. Stop it with `Ctrl+C` or `docker compose down`, and add `--volumes` to delete the database. The [judge guide](docs/judge-guide.md) walks through the full expedition.

<details>
<summary><strong>Troubleshooting</strong></summary>

- **Port 3000 or 55432 is already in use.** Stop the other process, or change the published port in `compose.yaml`.
- **The page says the service cannot reach its database.** Run `docker compose ps` and check that `db` is healthy and `migrate` exited with code 0. Use `docker compose logs migrate app` for details.
- **The image is stale after pulling new code.** Rerun with `--build`.

</details>

## Local development

**Requirements:** Node.js 24 LTS (see `.nvmrc`) and Docker for PostgreSQL.

```sh
npm ci
cp .env.example .env
npm run db:up                    # PostgreSQL 18 on localhost:55432
npm run db:migrate
npm run dev -w @ripple/server    # API on http://localhost:3000
npm run dev -w @ripple/web       # web app on http://localhost:5173, proxying the API
```

Workspace packages resolve to their TypeScript sources through the `ripple-source` export condition; `npm run build` emits JavaScript for production.

| Script                                    | Purpose                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `npm run lint`                            | ESLint with strict, type-aware rules                                      |
| `npm run format` / `format:check`         | Format with Prettier, or check formatting                                 |
| `npm run typecheck`                       | TypeScript across the root, every workspace and the browser tests         |
| `npm test`                                | Unit and property tests                                                   |
| `npm run test:integration`                | Integration tests against real PostgreSQL (`TEST_DATABASE_URL`)           |
| `npm run test:e2e`                        | Build, then run the browser journeys in installed Windows Chrome and Edge |
| `npm run build`                           | Compile the packages and server, and bundle the web app                   |
| `npm run db:up` / `db:migrate`            | Start PostgreSQL, or apply migrations                                     |
| `npm run db:generate -w @ripple/database` | Generate a migration from schema changes                                  |

## Configuration

The server validates its environment at startup and stops with a message naming each invalid variable, without echoing values. See [`.env.example`](.env.example).

| Variable               | Default            | Meaning                                                                      |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `DATABASE_URL`         | required           | PostgreSQL connection string                                                 |
| `DATABASE_POOL_MAX`    | `48`               | Shared connection budget for HTTP, workers and gateways (8–64)               |
| `HOST` / `PORT`        | `0.0.0.0` / `3000` | Listener address                                                             |
| `LOG_LEVEL`            | `info`             | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`               |
| `SHUTDOWN_GRACE_MS`    | `15000`            | Time to drain requests before forcing exit (1,000–120,000)                   |
| `WEB_ROOT`             | unset              | Built web app to serve; the Docker image sets it                             |
| `TEST_DATABASE_URL`    | unset              | Connection used by integration tests to create and drop temporary databases  |
| `ENABLE_LIVE_TWITCH`   | `false`            | Turns on the hosted Twitch integration; requires the variables below         |
| `ENABLE_COCOON_STUDIO` | `true`             | Installation-wide studio switch; each channel still opts in from its console |
| `ENABLE_CELEBRATIONS`  | `false`            | Optional cheer, subscription and hype train celebrations (presentation only) |
| `RULESET_VERSION`      | `candidate-1`      | Versioned balance parameters                                                 |

<details>
<summary><strong>Live Twitch variables</strong> (required when <code>ENABLE_LIVE_TWITCH=true</code>)</summary>

| Variable                 | Requirement                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `PUBLIC_BASE_URL`        | The stable HTTPS origin of the deployment                    |
| `TWITCH_REDIRECT_URI`    | `PUBLIC_BASE_URL` + `/auth/twitch/callback`                  |
| `TWITCH_CLIENT_ID`       | Twitch application client ID                                 |
| `TWITCH_CLIENT_SECRET`   | Twitch application client secret                             |
| `TWITCH_EVENTSUB_SECRET` | 32–100 printable ASCII characters                            |
| `TOKEN_ENCRYPTION_KEY`   | Independently generated 32-byte base64 key for stored grants |
| `SESSION_SECRET`         | Independently generated 32-byte base64 key                   |
| `ACTOR_HASH_KEY`         | Independently generated 32-byte base64 key; keep it stable   |
| `OPERATOR_SECRET`        | Independently generated secret of at least 32 characters     |

Keep real values in your host's secret store, never in the repository or a Docker build argument. The [Twitch setup guide](docs/twitch-setup.md) covers each step.

</details>

## Testing and quality

Every push to `main` runs the full pipeline in GitHub Actions. The latest green run executed **490 unit tests, 225 real-PostgreSQL integration tests and 98 browser journeys**.

| Layer                   | What it covers                                                                                                                                                   | Command                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Unit and property tests | Engine rules, contracts, gestures, editor state and services, with fast-check over every legal genome                                                            | `npm test`                 |
| Integration tests       | Real PostgreSQL: ordering, transactions, crash and retry, raid races, studio flows, privacy and replay                                                           | `npm run test:integration` |
| Browser journeys        | Installed Chrome and Edge against the real service and security headers: studio with real model inference, console, overlay, lineage, sandbox, axe WCAG 2.1 A/AA | `npm run test:e2e`         |
| Installed smoke tools   | Inside the production image: a round, raids, mechanics, a studio break and the judge API journey                                                                 | `npm run smoke:*`          |
| Installed judge journey | A real browser drives the installed app end to end with no intercepted requests                                                                                  | `npm run test:judge`       |
| Policy simulator        | Six policies across six habitats on a held-out split, with reproducible results                                                                                  | `npm run simulate`         |
| Restore rehearsal       | Real dump, separate-database restore, reapplied erasures and deterministic replay                                                                                | `npm run test:restore`     |
| Release load            | Signed HTTP intake, 300 live sockets, simultaneous studios and a worker killed after commit, with strict latency and durability gates                            | `npm run test:load`        |

CI runs four jobs: lint, formatting, notices, types, unit, build, integration and simulator checks on Linux; the browser suite on Windows; a Compose smoke test that starts the stack exactly as an evaluator would; and two independent release-load trials. Measured results and their limits are recorded in the [Phase 9](docs/evidence/phase9.md) and [Phase 10](docs/evidence/phase10.md) evidence.

## Determinism and replay

Accepted records are the source of truth. Each channel's records form a checksum chain, and cross-channel dependencies such as raids record the destination positions they observed.

```sh
npm run replay -- export WORLD_ID bundle.json   # every channel's accepted records
npm run replay -- verify bundle.json            # checksums, rules and dependency bounds
npm run replay -- run bundle.json               # rebuild in a new, isolated replay world
```

`run` rebuilds the world in channel order, waits for raid dependencies, prints each channel's resident, committed design and studio outcomes, and compares the result with the source world channel by channel, exiting with code 2 on any difference. Replay uses accepted records only: no camera data, landmarks or provider calls.

## Security and privacy

- **Webhooks** are verified with HMAC over the raw request bytes, deduplicated by receipt and reconciled against Twitch's subscription state.
- **Owner controls** use Twitch sign-in sessions with `__Host-` cookies, an exact `Origin` check, CSRF tokens, idempotency keys and channel version checks.
- **Grants and secrets** are encrypted at rest with independent keys. Changing `ACTOR_HASH_KEY` refuses startup rather than silently changing vote identity.
- **Hardening** includes security headers with a strict Content Security Policy, rate limiting and bounded input everywhere.
- **Camera privacy.** Video and hand landmarks stay in the browser, the microphone is never requested, and camera tracks stop when the studio closes.
- **Anonymous analytics.** Only allow-listed events with counts and kinds are recorded: no viewer identities, chat text, video or landmarks. Live and sandbox populations are kept separate.
- **Erasure.** Artists can choose **Forget my artist identity**. Accepted records hold opaque credit tokens, so replay survives erasure. Retention runs every 30 seconds, and a separate erasure ledger keeps restores honest. See [privacy operations](docs/privacy-operations.md).

## Twitch integration

Live integration is off by default, so local evaluation needs no secrets. When enabled, Ripple supports broadcaster and operator-bot OAuth with encrypted grants and refresh leases, signed EventSub intake with subscription reconciliation, chat voting and activity with Shared Chat deduplication, stream online and offline recovery, and bounded bot output through a committed outbox. Raids arrive as signed `channel.raid` notifications.

Open `/controller` on a configured HTTPS deployment to connect a channel. The [Twitch setup guide](docs/twitch-setup.md) lists the exact redirect URLs, scopes, operator bot authorization and the live acceptance checklist. For a rehearsal on a local machine behind an HTTPS tunnel:

```sh
docker compose -f compose.yaml -f compose.live.yaml up --build -d
```

## Deployment and operations

The recommended first host is **Railway**: one always-on Docker service and a private PostgreSQL 18 service in the same region. [`railway.json`](railway.json) runs migrations as a pre-deploy step, gates rollout on `/health/ready` and drains connections for 20 seconds. Keep app sleep disabled: webhooks, sockets and round deadlines need a running process.

| Endpoint        | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `/health/live`  | Liveness: the process is serving                        |
| `/health/ready` | Readiness: the database is reachable and migrations ran |

- [Deployment guide](docs/deployment.md): topology, sizing, backups and point-in-time recovery, cost.
- [Operations runbook](docs/operations.md): alerts, incident recovery, backup and restore, deploy and rollback.
- `npm run status` prints private backlog, deadline, delivery and database diagnostics.

## Command-line tools

All tools run from source with `npm run <script>`, and the production image ships them under `apps/server/dist/cli/`.

| Script                               | Purpose                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `sandbox`                            | Create and drive isolated synthetic worlds: votes, activity, raids, studio breaks, pauses and claims |
| `smoke:game` / `raids` / `mechanics` | Verify a synthetic round, a two-channel raid, or earned mechanics against a running app              |
| `smoke:studio` / `smoke:judge`       | Verify a studio break through hatch and raid, or the keyless judge API journey                       |
| `test:judge`                         | Drive the installed app in a real browser with no intercepted requests                               |
| `simulate`                           | Run the deterministic policy and studio simulator                                                    |
| `replay`                             | Export, verify and rebuild a world from accepted records                                             |
| `metrics`                            | Print product and studio metrics with numerators, denominators and limits                            |
| `privacy`                            | Targeted erasure, expired-world purge and the erasure ledger                                         |
| `status`                             | Private operational diagnostics                                                                      |
| `test:load` / `test:restore`         | Release load test, and the dump and restore rehearsal                                                |
| `release:package`                    | Package the exact validated source with a SHA-256 manifest                                           |

<details>
<summary><strong>Synthetic world CLI</strong></summary>

`npm run sandbox -- create` creates and seeds a labelled synthetic world that expires after 24 hours, and returns its IDs, a private owner capability, a read capability and a snapshot. Set `RIPPLE_SANDBOX_CAPABILITY` to the owner capability, then use the returned IDs:

```sh
npm run sandbox -- vote WORLD_ID CHANNEL_ID alice 2
npm run sandbox -- advance WORLD_ID CHANNEL_ID 3200
npm run sandbox -- activity WORLD_ID CHANNEL_ID alice
npm run sandbox -- advance WORLD_ID CHANNEL_ID 12000
npm run sandbox -- status WORLD_ID CHANNEL_ID
```

| Commands                                                                         | Purpose                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `vote`, `activity`, `advance`, `status`                                          | Drive ballots and observations on the shared synthetic clock         |
| `pause`, `resume`, `offline`, `online`, `input-outage`, `recover`                | Exercise pauses, stream outages and interrupted-observation recovery |
| `peer`, `seed`, `policy`, `prepare`, `raid`, `admit`, `decline`                  | Add up to eight channels, raid between them and manage admission     |
| `block-source`, `block-lineage`, `raid-unknown`, `claim`                         | Blocks, raids to unenrolled channels and historical adoption         |
| `enable-mechanics`, `traces`, `clear-traces`                                     | Mechanics upgrades and trace controls                                |
| `studio-settings`, `studio-start`, `studio-stop`, `bridge-scene`, `bridge-stale` | Studio configuration, manual breaks and simulated OBS bridge reports |
| `studio-propose`, `studio-withdraw`, `studio-review`, `studio-release`           | Synthetic artists, review and release                                |

Each `advance` accepts 1–300,000 milliseconds and returns an operation UUID; passing it again retries the same step without advancing twice. Live worlds reject synthetic clocks and commands.

</details>

## HTTP and real-time API

<details>
<summary><strong>Endpoint overview</strong></summary>

| Area              | Endpoints                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health            | `GET /health/live`, `GET /health/ready`                                                                                                                             |
| Scoped reads      | `GET /api/worlds/:id/snapshot`, `GET /api/lineages`, `GET /api/lineages/:id`, `GET /api/organisms/:id/passport`, `GET /api/rounds/:id/explanation`                  |
| Real time         | `POST /api/overlay/exchange` for a single-use 30-second ticket, then the `/api/live` WebSocket                                                                      |
| Broadcaster       | `/api/controller/*` (status, commands, blocks, metrics, read capability, studio) and `/api/channels/:id/*` (seed, control, studio settings, start and stop, bridge) |
| Studio and artist | `/api/studios/:id`, proposals, review and release; `/api/blueprints/:hash`; `/api/artist/status`; `POST /api/artist/forget`                                         |
| Sandbox           | `POST /api/sandbox`, then `/api/sandbox/:worldId/actions`, `/replay` and `/reset`                                                                                   |
| Twitch            | `/auth/twitch/start`, `/auth/twitch/bot/start`, `/auth/twitch/artist/start`, `/auth/twitch/callback`, `POST /webhooks/twitch`                                       |
| Analytics         | `POST /api/analytics` for allow-listed anonymous events                                                                                                             |

Scoped reads take `worldId` and `channelId` query parameters and `Authorization: Bearer <read capability>`. Owner writes require a signed-in session, a CSRF token, an idempotency key and the current channel version. WebSocket vote aggregates are limited to twice per second.

</details>

## Repository layout

```text
apps/
  server/        Fastify service: HTTP API, Twitch, ordered worker, gateways, simulator, CLIs
  web/           React + Vite: landing, console, overlay, studio, sandbox, lineage, bridge
packages/
  engine/        Pure, deterministic game rules
  contracts/     Zod schemas shared by the server and the browser
  database/      Drizzle schema, SQL migrations and the migration runner
tests/           Browser journeys, installed-judge check, restore rehearsal and release packager
docs/            Specification, guides, runbooks, measured evidence and demo
```

## Project status

| Area                                               | Implemented and verified in CI | Live acceptance                                       |
| -------------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Game engine, persistence, ordered worker, gateways | Yes                            | Not applicable                                        |
| Twitch live loop: OAuth, EventSub, chat, bot       | Yes, with provider fixtures    | Pending: needs broadcaster and bot accounts           |
| Raids, welcome, shelter, contests, lineage         | Yes                            | Pending: needs a real two-channel raid                |
| Traces, dormant mutations, ancestor trials         | Yes                            | Pending with the live loop                            |
| Cocoon Studio and OBS bridge                       | Yes                            | Pending: two-channel studio rehearsal and OBS capture |
| OBS overlay                                        | Yes, in Chrome and Edge        | Pending: real OBS readability check                   |
| Judge sandbox, replay, simulator, analytics        | Yes                            | Not applicable                                        |
| Load, restore, retention and runbooks              | Yes, measured synthetically    | Pending: hosted capacity and backup recovery          |

Synthetic and sandbox results never count as live acceptance. A [labelled synthetic demo](docs/demo/README.md) records the installed app through the whole loop; authentic Twitch and OBS footage follows live acceptance. The remaining operator steps are listed in the [release handoff](docs/submission.md#deferred-acceptance-and-operator-handoff).

## Documentation

| Document                                             | Contents                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [Product specification](docs/prd.md)                 | Game model, rules, architecture, data model, API and acceptance |
| [Cocoon Studio specification](docs/cocoon-studio.md) | The studio addendum: flows, rules, privacy and verification     |
| [Delivery plan](docs/plan.md)                        | Phased implementation plan and its exit checks                  |
| [Judge guide](docs/judge-guide.md)                   | The three-minute sandbox expedition and replay tools            |
| [Twitch setup](docs/twitch-setup.md)                 | Accounts, redirect URLs, secrets and live acceptance checklists |
| [Deployment](docs/deployment.md)                     | Hosting topology, sizing, backups and cost                      |
| [Operations](docs/operations.md)                     | Monitoring, incidents, restore, deploy and rollback             |
| [Privacy operations](docs/privacy-operations.md)     | Retention and deletion procedures                               |
| [Release handoff](docs/submission.md)                | Reviewable artifacts, packaging and deferred acceptance         |
| [Phase 9 evidence](docs/evidence/phase9.md)          | Balance, simulator, replay and judge measurements               |
| [Phase 10 evidence](docs/evidence/phase10.md)        | Load, restore, client performance and hardening results         |
| [Synthetic demo](docs/demo/README.md)                | What the recorded demonstration shows, and how to reproduce it  |

## Acknowledgements and license

Hand tracking uses Google's [MediaPipe](https://ai.google.dev/edge/mediapipe) Tasks Vision runtime and hand landmarker model under the Apache-2.0 license, served locally from pinned, checksum-verified files. Typefaces are self-hosted from Fontsource. Full attributions and license texts are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This repository does not yet include a license file. Third-party components keep their own licenses.
