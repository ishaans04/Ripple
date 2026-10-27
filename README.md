# Ripple

Ripple is a Twitch-connected, deterministic evolution game shared by streamers and their communities. Chat makes bounded mutation decisions, the channel's observed activity creates selection pressure, and a real raid branches a descendant into another channel, where the receiving community shapes its next adaptation.

> Communities shape living strains. Raids carry their descendants. Every host changes the lineage, and successful visitors leave a trace for those who follow.

The full specification is in [docs/prd.md](docs/prd.md), extended by the [Cocoon Studio addendum](docs/cocoon-studio.md), and the phased delivery plan is in [docs/plan.md](docs/plan.md).

## Current status

Ripple is being built phase by phase. **Phase 0 (foundation) and Phase 1 (pure engine) are complete.** What works today:

**Phase 2 is in progress:** the shared studio contracts now validate bounded, immutable shell blueprints and captured challenges. The editor and hand-tracking integration are being built next. See [delivery progress](docs/progress.md) for resolved studio policies and remaining exit checks.

- The application service (Fastify on Node.js 24) with structured, correlated JSON logs, a uniform error contract, security headers, and graceful shutdown
- PostgreSQL 18 with versioned migrations applied exactly once under an advisory lock, starting with the `worlds` table that isolates live, sandbox, and replay state
- Liveness and readiness endpoints (`/health/live`, `/health/ready`)
- The web landing page, served by the same service, showing live service status
- One-command local startup with Docker Compose, and CI covering lint, types, unit tests, integration tests on real PostgreSQL, the build, and a Compose smoke test
- The deterministic game rules as a tested library (`@ripple/engine`; see [Game engine](#game-engine)), reproducing the PRD's worked journey (section 25.4) exactly

The engine is not yet wired to rounds, persistence, Twitch, or any screen, so the game is not playable yet. Cocoon Studio (break-time, hand-shaped community designs), the event backbone, Twitch integration, raids, overlay, and sandbox arrive in later phases; see the [plan](docs/plan.md).

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

| Script                                    | Purpose                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| `npm run lint`                            | ESLint with strict type-aware rules                             |
| `npm run format` / `format:check`         | Prettier                                                        |
| `npm run typecheck`                       | TypeScript across the root and every workspace                  |
| `npm test`                                | Unit tests                                                      |
| `npm run test:integration`                | Integration tests against real PostgreSQL (`TEST_DATABASE_URL`) |
| `npm run build`                           | Compile packages and the server; bundle the web app             |
| `npm run db:up` / `db:migrate`            | Start PostgreSQL / apply migrations                             |
| `npm run db:generate -w @ripple/database` | Generate a migration from schema changes                        |

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

The lifecycles built on these rules (round scheduling, trace and dormant lifetimes, admission, contests) arrive with the phases that persist them.

## Architecture

One TypeScript application service plus PostgreSQL, deployed as a single image (see PRD section 12). Browsers never connect to the database. The same image runs locally under Compose and in hosted deployments, with migrations applied as a separate pre-start step.
