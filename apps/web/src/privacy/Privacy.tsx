import styles from './Privacy.module.css';
export default function Privacy() {
  return (
    <main className={styles.content}>
      <a href="/">Ripple</a>
      <h1>Privacy and data deletion</h1>
      <p>
        Camera video and hand landmarks stay in your browser. Ripple never requests a microphone or
        uploads camera frames. Hand controls are optional and grant no extra game power.
      </p>
      <h2>Artist identity</h2>
      <p>
        Twitch artist sign-in requests identity only. Its access token is discarded after
        validation. The server keeps a separate, erasable sign-in and credit mapping; game history
        carries a random pseudonym and an opaque credit token.
      </p>
      <p>
        In a connected studio, choose “Forget my artist identity” to erase the mapping and sign-in
        sessions. New reads show “Former artist” on accepted designs. Designs, genes and anonymous
        game provenance remain unchanged. Signing in again creates a new pseudonym; it does not
        restore old credit.
      </p>
      <p>
        Sign-in sessions expire after 12 hours. Credit mappings expire 30 days after the most recent
        artist sign-in. Local drafts remain on your own device; use Reset shell or clear this site's
        browser storage to remove them.
      </p>
      <h2>Operational records</h2>
      <p>
        Processed raw intake and closed-round voting/activity membership expire after 24 hours.
        Compact accepted records and receipt hashes retain deterministic replay and duplicate
        protection for the world. These contain scoped pseudonyms, not raw chat text or camera data.
      </p>
      <p>
        Expired sign-in states and connection tickets are cleaned up automatically. Operational
        delivery records and public update history expire after seven days. Sandbox worlds expire
        after one day and are then purged; reset expires your old world immediately.
      </p>
      <p>
        Live gameplay history remains for the active world/season. Its operator controls season
        retirement and whole-world deletion, including broadcaster/channel identifiers. Backups have
        a separately documented retention window; an operator reapplies identity erasures before
        exposing a restored database.
      </p>
      <h2>What metrics mean</h2>
      <p>
        Minimal event counts describe use, failures and submitted designs. Camera/pointer
        attribution is advisory and affects no game rule. These counts do not establish watch-time
        retention or identify silent viewers.
      </p>
      <p>
        For an operator-assisted deletion or data export, contact the broadcaster or deployment
        operator. The repository's privacy runbook describes exact deletion scope, retention and
        backup handling.
      </p>
    </main>
  );
}
