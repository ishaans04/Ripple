# Twitch live setup

Phase 4 implements the adapter and controller. Real Twitch and hosted acceptance are **pending** until the two test broadcasters, operator bot and stable HTTPS URL exist. Local Docker evaluation and `/studio` practice need no Twitch account or secret. Live votes have no browser submission endpoint.

## Register and configure

1. Create the bot account and two broadcaster accounts. Enable the email verification and two-factor authentication required to register a [Twitch application](https://dev.twitch.tv/docs/authentication/register-app/). Register one confidential application. Keep its client secret in the deployment's secret store.
2. Deploy this repository's Dockerfile as one persistent Railway application with private PostgreSQL in the same region. The committed `railway.json` supplies the migration pre-deploy command, readiness check, restart policy and shutdown drain. Keep one application replica and disable service sleeping in Railway's settings. Attach persistent PostgreSQL storage; configure backups separately. See [Railway configuration](https://docs.railway.com/config-as-code/reference).
3. Assign a stable HTTPS domain. Set `PUBLIC_BASE_URL` to its origin, without a path or trailing slash. Set `TWITCH_REDIRECT_URI` to that origin plus `/auth/twitch/callback`, and register that **exact** URL in Twitch. The webhook URL is the origin plus `/webhooks/twitch`; it must be publicly reachable over HTTPS.
4. Set `DATABASE_URL` to the private database URL, `HOST=0.0.0.0`, `SHUTDOWN_GRACE_MS=15000`, `RULESET_VERSION=candidate-1` and the application credentials. Generate **three independent** 32-byte base64 values for `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET` and `ACTOR_HASH_KEY`. Generate a separate 64-character hexadecimal `TWITCH_EVENTSUB_SECRET` and an independent `OPERATOR_SECRET` of at least 32 characters. Generate secrets locally with Node's `crypto.randomBytes`; never put them in chat, source control, URL parameters or screenshots.
5. Set `ENABLE_LIVE_TWITCH=true` and deploy. Incomplete, mismatched or insecure configuration fails startup without printing secret values. `/health/ready` confirms the service and migrations, not Twitch readiness. The default Compose file deliberately does not forward live secrets from `.env` into containers.

## Authorize the bot and broadcasters

Open `/controller` on the HTTPS deployment. Under **Operator bot setup**, enter the deployment's operator secret and select **Authorize bot account**. Sign into the intended bot account at Twitch. This separate flow requests `user:read:chat`, `user:write:chat` and `user:bot`. It issues no broadcaster-control session. The secret is sent in a same-origin request body, never a URL.

For each broadcaster, use **Connect broadcaster with Twitch** and approve `channel:bot`. Viewers keep voting in Twitch chat without authorizing Ripple. These cloud-bot grants follow [Twitch's authentication model](https://dev.twitch.tv/docs/chat/authenticating/). Access and refresh tokens are authenticated ciphertext in PostgreSQL and never returned to browsers.

The controller lists broadcaster authorization, bot authorization, signed callback verification, enabled subscriptions, stream status and read-only preview connection separately. Reconciliation runs at startup and every 30 seconds; creating subscriptions have a 90-second retry backoff. A redirect alone never means the channel is ready. The required subscriptions are `channel.chat.message` v1, `stream.online` v1, `stream.offline` v1, `channel.update` v2 and the Phase 5 outgoing `channel.raid` v1 subscription.

Start the broadcaster's stream, wait for healthy inputs, choose the visitor policy, enter an approved name and **Seed strain**. The founder uses `[6,6,6,6]` and the ruleset's starting health. Empty channels have a 180-second reseeding cooldown, measured from their last committed seed. Names are limited to 40 characters and rendered as text.

Use **Create or rotate preview link** and open the resulting read-only link. Its capability stays in the URL fragment, outside HTTP requests and server logs. Rotation revokes previous links. A connected preview proves a read client is connected; it does not prove OBS capture readability. The full broadcast overlay is Phase 7.

## Live acceptance to record

On a real broadcaster's live channel, send `!ripple 1`, then `!ripple 2` from the same viewer; the first valid vote must stand. Use another viewer for a different choice. Wait for the actual 45-second ballot plus one-second grace; verify the committed mutation and bot announcement. Observe the 120-second habitat interval and 14-second reveal, including limited-confidence behavior with fewer than three distinct accounts. Ordinary local activity is capped to one contribution/account/ten-second bucket. Ripple commands and the bot never add habitat activity.

Repeat with two channels in Shared Chat: only the originating enrolled channel may count each message. Confirm stream offline freezes active time, a clean return resumes it, a manual pause remains manual, and a revoked subscription interrupts observation. Fix the indicated grant/callback step, resume a manual pause if necessary, and explicitly **Recover interrupted observation**. Recovery retains committed genes and starts a fresh observation epoch. Save dated evidence and observed results in `docs/progress.md`; fixture tests cannot satisfy this gate.

## Two-channel raid acceptance to record

This gate is pending real accounts and HTTPS. Connect both broadcasters in the same installation and confirm all five subscriptions are ready on each channel. Start both streams. Seed the source and, to exercise a contest, seed the destination too. Set the destination visitor policy to **Ask**.

1. In the source controller, queue a preparation ballot. Finish the existing ballot/observation first, then vote for Shield in chat and verify the standing choice changes only after commitment. A raid before that commitment must use the previous choice.
2. Initiate an actual Twitch raid from the source to the destination. Save the dated receipt/transfer identifiers without credentials or voter identities. Verify exactly one child and an unchanged living source parent. The destination must show the origin and an approval hold; its open ballot must remain unchanged.
3. Approve the visitor in the destination controller. Verify the committed result, arrival and queued welcome. Use destination chat to select Shelter when offered. Record the actual finite energy transfer and one valid observation with the contest deferred. Then complete the next valid observation and verify the fitness comparison, incumbent tie rule, resident and fossil records. A limited-confidence interval must hold the contest and shelter.
4. Repeat an arrival with the destination offline or manually paused, then restore it and verify a held arrival resumes through admission rather than accumulating offline decay. Exercise explicit decline separately: the child is archived with a refusal outcome, not fossilized by activity. Exercise source/lineage blocks and unblock controls.
5. Save observed outcomes, screenshots and relevant event identifiers in the progress record. Label any accelerated/synthetic footage separately. The installed `smoke:raids` journey verifies application behavior with synthetic inputs; it does not establish this live gate. OBS readability remains a separate acceptance check.

## Credentials, retries and recovery

- User grants are validated on startup, hourly, and after stored expiry. Refresh is serialized per grant; its rotated refresh token is saved before releasing the lease. Revocation ends dependent controller sessions and holds live observation. Transient provider failures remain visible and retry. See [Twitch validation](https://dev.twitch.tv/docs/authentication/validate-tokens/).
- Rotate `SESSION_SECRET` to invalidate existing controller cookies; broadcasters sign in again. Rotate `OPERATOR_SECRET` independently to change access to bot setup. OAuth state expires after ten minutes and cannot be reused.
- Preserve `ACTOR_HASH_KEY` during a live world's lifetime. Startup rejects an unexplained change so one account cannot gain another vote identity halfway through a ballot. A new world/season requires an explicit administrative migration with history retained.
- Rotate the token encryption key only with the application stopped and a verified database backup. Re-encrypt every grant using its original world/purpose/subject authenticated context before starting with the new key, or remove the old grants and controller sessions and require all broadcasters and the bot to authorize again. Never change the configured key while old ciphertext remains in use.
- Rotating the EventSub secret or changing the origin triggers subscription replacement. Keep observation held until new signed callbacks verify. Re-register the exact OAuth redirect if the origin changes.
- Bot output is limited to twelve attempts/minute globally and one/ten seconds/channel. Expired ballot announcements are discarded. A send whose response is lost is marked uncertain and not blindly resent; inspect `bot_messages` status without dumping credentials or message payloads into public logs.
- Owner commands use CSRF, an expected state version and a UUID idempotency key. A 202 response means durable acceptance; the controller waits for the worker's actual result. If the connection drops, **Retry pending command** resends the same key and body. A stale-version rejection requires reviewing current state before a new command.

Backup/restore rehearsal, retention policy enforcement, physical-device measurements, OBS readability and final release acceptance remain Phase 10 work. No public deployment has been claimed or created by these instructions.
