# Ripple

Ripple is a Twitch-connected, deterministic evolution game shared by streamers and their communities. Chat makes bounded mutation decisions, the channel's observed activity creates selection pressure, and a real raid branches a descendant into another channel, where the receiving community shapes its next adaptation.

> Communities shape living strains. Raids carry their descendants. Every host changes the lineage, and successful visitors leave a trace for those who follow.

The full specification is in [docs/prd.md](docs/prd.md), and the phased delivery plan is in [docs/plan.md](docs/plan.md).

## Current status

Ripple is being built phase by phase. **Phase 0 (foundation) is complete.** What works today:

- The application service (Fastify on Node.js 24) with structured, correlated JSON logs, a uniform error contract, security headers, and graceful shutdown
- PostgreSQL 18 with versioned migrations applied exactly once under an advisory lock, starting with the `worlds` table that isolates live, sandbox, and replay state
- Liveness and readiness endpoints (`/health/live`, `/health/ready`)
- The web landing page, served by the same service, showing live service status
- One-command local startup with Docker Compose, and CI covering lint, types, unit tests, integration tests on real PostgreSQL, the build, and a Compose smoke test

Gameplay (the engine, Twitch integration, raids, overlay, and sandbox) arrives in later phases; see the [plan](docs/plan.md).

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
packages/database/   Drizzle schema, SQL migrations, migration runner
docs/                PRD, delivery plan, and archived design history
```

## Architecture

One TypeScript application service plus PostgreSQL, deployed as a single image (see PRD section 12). Browsers never connect to the database. The same image runs locally under Compose and in hosted deployments, with migrations applied as a separate pre-start step.
