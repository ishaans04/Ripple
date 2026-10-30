import type { ControllerStatus } from '@ripple/contracts';
import styles from './Controller.module.css';

const kindText = { cheer: 'cheers', subscription: 'subscriptions', hype_train: 'hype trains' };

/** Optional paid-event celebrations: an explicit, separate grant with no gameplay effect. */
export function CelebrationsCard({ status }: { status: ControllerStatus }) {
  const celebrations = status.celebrations;
  if (celebrations === undefined) return null;
  return (
    <section className={styles.panel} aria-label="Optional celebrations">
      <h2>Optional celebrations</h2>
      <p>
        Cheers, subscriptions and hype trains can show a short thank-you on the overlay. They never
        change genes, energy, votes or survival, a larger payment never makes a larger effect, and
        at most one celebration appears per minute.
      </p>
      {!celebrations.available ? (
        <p>Celebrations are turned off for this Ripple installation.</p>
      ) : (
        <>
          <p>
            {celebrations.granted.length === 0
              ? 'Not authorized. Ripple will not read paid events for this channel.'
              : `Authorized for ${celebrations.granted.map((kind) => kindText[kind]).join(', ')}. Twitch only sends events this channel is eligible for.`}
          </p>
          <a className={styles.button} href="/auth/twitch/start?celebrations=true">
            {celebrations.granted.length === 0
              ? 'Authorize optional celebrations'
              : 'Re-authorize celebrations'}
          </a>
        </>
      )}
    </section>
  );
}
