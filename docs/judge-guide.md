# Run a judge expedition

## Start a clean installation

Install Docker, clone the repository, and run:

```sh
docker compose up --build
```

Open <http://localhost:3000>, choose **Try sandbox**, then **Start my sandbox**. No Twitch grants, bot account, public URL, camera or OpenAI key are required. The first image download/build is installation time. Each judge gets a separate, one-day synthetic world with a home and a neighbor. The persistent badge labels the accelerated clock and every synthetic action.

## The short journey

1. Choose **Synthetic vote 1**, then **Next scheduled step** to close mutation voting. Choose **Add local chat**, optionally **Change habitat**, then **Next scheduled step** to resolve the observation. The channel card explains actual energy, the ancestor comparison and available mechanic records. A limited observation holds health.
2. Choose **Simulate raid to other channel**, switch to **Neighbor channel**, and use **Next scheduled step** to reach its welcome ballot. Vote on a displayed welcome choice and advance; add chat during observation to compare the visitor with its incumbent. Preparation, shelter, trace offers and dormant options obey their normal eligibility and limits; the judge controls do not grant them for free.
3. Switch home and advance from reveal to the next mutation ballot. Choose **Start break studio**. The ordinary game clock checkpoints while creation is open. Edit with pointer, keyboard, touch, or optional hand controls; choose **Review and submit**, then **Submit proposal**. Editing alone never submits. Artist identity is explicitly synthetic, and no live artist sign-in is impersonated.
4. Choose **Next scheduled step** to close creation. The displayed finalist list includes **Keep current**; use its displayed option number or vote for a design. Advance to review and choose **Approve design** or **Keep current design**. An approved shell remains unapplied until the eligible mutation boundary. Advance through observation and the hatch slot; the committed shell then appears on the creature. Repeated breaks cannot create extra mutation slots.
5. Open **Inspect round details** or **Lineage and passports** for scoped read-only inspection. Choose **Replay and verify** to reconstruct both channels, including studio appearance, from accepted records alone. The result reports equality and gives read-only links to the replay world. **Reset sandbox** expires the old world and creates an independent fresh expedition.

Home and neighbor share the synthetic clock. Advancing one channel also processes due work elsewhere; it never advances live Twitch time. Stable judge/crowd accounts each get one accepted vote per ballot. Errors and limits are shown from committed results; retrying a different vote cannot overwrite the first. A lost connection keeps the local editor draft, and the world fragment reloads the same expedition. An expired world offers reset.

The automated installed browser journey, including a confirmed pointer design, hatch, replay, lineage inspection and reset, measured 19.2 seconds. This is an automated path after startup, not measured human reading time. See [the evidence](evidence/phase9.md).

## Replay and analytics tools

With Node.js 24, `npm ci`, and the local database configured as in `.env.example`, commands run from the repository root:

```sh
npm run replay -- export WORLD_UUID tmp/expedition.json
npm run replay -- verify tmp/expedition.json
npm run replay -- run tmp/expedition.json
npm run metrics -- WORLD_UUID all sandbox
npm run simulate -- --split held-out --rounds 36 --output tmp/balance.json
```

Create the output directory first. The CLI resolves file paths against the invoking directory. Export includes every channel's accepted records and cross-channel dependencies; drain pending input before exporting. Offline verification checks checksums, rules, source-world context and dependency bounds. Run reconstructs an isolated, expiring replay and compares the source when it exists locally. It exits nonzero for a divergence. Replay worlds do not generate new product analytics.

Metrics keep live and sandbox populations separate, report missing denominators as null, distinguish accepted server events from advisory browser signals, and expose the input-modality completion denominators. These counts do not demonstrate retention. No video or landmarks enter them, and declared input modality affects no game rule.

After installation, `npm run smoke:judge` checks the real HTTP path. `npm run test:judge` drives an actual Chromium browser against the installed application with no intercepted requests; first install Chromium with `npx playwright install chromium`. On Windows with installed Chrome, set `JUDGE_BROWSER_CHANNEL=chrome`. `JUDGE_BASE_URL` can select another local installation. Normal `npm run test:e2e` runs the complete Windows Chrome/Edge browser suite on its own server; do not run two suites on the same port or artifact directory concurrently.

Real Twitch chat, raids, the two-channel studio rehearsal and real OBS capture remain pending. [Twitch setup](twitch-setup.md) documents those gates; sandbox or accelerated footage must stay labeled.
