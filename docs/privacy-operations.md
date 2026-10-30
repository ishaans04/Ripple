# Retention and deletion

The public `/privacy` page describes the implemented policy. Camera frames and landmarks never enter the server. Artist OAuth tokens are discarded after identity validation; artist sessions last 12 hours. A private identity vault maps an account HMAC to a random game pseudonym and opaque credit token for 30 days after sign-in. Accepted game records contain the pseudonym/token. Credit names resolve only when presenting a response or sending a bot message.

**Forget my artist identity** removes the mapping and every artist session for that pseudonym. New reads display Former artist; genes, immutable designs and anonymous provenance remain. Signing in again cannot reclaim the old credit. Existing screenshots, previously received browser content and Twitch bot messages cannot be recalled by Ripple. Broadcaster access/refresh credentials are encrypted separately; disconnect/revocation is covered in the Twitch setup guide.

The application runs maintenance every 30 seconds with a database advisory lock. It deletes processed raw intake and completed-round vote/activity membership after 24 hours, provider receipts, delivered/expired bot records and public update payloads after seven days, and expired sessions, tickets, OAuth states and identity mappings. The largest queues are limited to 10,000 deletions per cycle; failures retain data for retry and log an error. Pending intake and active-round membership never expire through this job. Compact receipt hashes and normalized accepted game records remain for deterministic replay and duplicate protection. Replay records contain scoped account pseudonyms; these are not claimed to be irreversibly anonymous.

Expired sandbox/replay worlds are purged atomically, up to five per cycle. Live world history remains for the season. Choose and document a season duration with participants before enabling real channels; no live-world expiry is silently assigned. To retire a live season, stop ingress and workers, export any permitted history, set the reviewed world's expiry, and explicitly purge it. Shared immutable rulesets remain. There are no real-user legacy histories at initial release; migration 35 invalidates pre-vault sessions. Importing older histories containing names requires a separate privacy review.

Operator commands use the configured database and print counts, never provider secrets:

```sh
npm run privacy -- maintain --apply
npm run privacy -- forget-artist WORLD_UUID ARTIST_KEY --apply --confirm WORLD_UUID
npm run privacy -- purge-world EXPIRED_WORLD_UUID --apply --confirm EXPIRED_WORLD_UUID
npm run privacy -- export-ledger /secure/erasures.json
npm run privacy -- apply-ledger /secure/erasures.json --apply --confirm erasures
```

Keep the opaque erasure ledger in encrypted storage separate from database backups and export it after every deletion request, before confirming completion to a participant. The ledger holds only world UUID, disconnected artist key and request time. Export refuses more than 100,000 entries rather than silently truncating. Retire seasons or partition the export operationally before reaching that limit. Restrict filesystem access (Unix exports request mode 0600; configure equivalent Windows ACLs).

Restore backups into a private, separate database. **Before any public traffic**, reapply the latest independently retained erasure ledger, run maintenance, verify replay and identity resolution, and rotate old sessions/capabilities if restoring to a different environment. Backups retain old mappings until their configured expiry: use a documented seven-day backup retention baseline, verify provider retention and deletion, and never promise immediate deletion from an immutable backup. The restore rehearsal verifies actual database recovery; ledger reapplication has its own PostgreSQL regression.

Before a public deployment, the operator must publish a contact address and retention/backup policy alongside this notice. Use that channel for account-linked requests that cannot use self-service sign-in. Do not request a raw Twitch token, camera recording or browser capability in a support ticket.
