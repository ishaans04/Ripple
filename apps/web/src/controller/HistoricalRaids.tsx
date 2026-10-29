import type { ControllerStatus, PropagationView } from '@ripple/contracts';
import styles from './Controller.module.css';

export function HistoricalRaids({
  offers,
  outgoing,
  disabled,
  control,
  requested,
}: {
  offers: NonNullable<ControllerStatus['historicalOffers']>;
  outgoing: PropagationView['outgoing'];
  disabled: boolean;
  control: (body: Record<string, unknown>) => void;
  requested: boolean;
}) {
  const invitations = outgoing.filter((t) => t.outcome === 'NOT_ENROLLED' && t.childId !== null);
  if (offers.length === 0 && invitations.length === 0 && !requested) return null;
  return (
    <section className={styles.panel} aria-label="Historical raid invitations">
      <h2>Historical raid invitations</h2>
      <p>
        These descendants were reserved during an earlier raid. Adoption uses that captured design
        and energy, with the original expiry and normal admission holds. It is not a new live raid.
      </p>
      {requested && offers.length === 0 && (
        <p role="note">
          No unexpired historical invitation is available for this signed-in channel. Only the
          original raid destination can adopt a retained descendant.
        </p>
      )}
      {offers.map((offer) => (
        <section key={offer.id}>
          <h3>Earlier raid from {offer.sourceLabel}</h3>
          <p>
            Raid recorded {new Date(offer.createdAt).toLocaleString()} · Invitation expires{' '}
            {offer.expiresAt === null ? 'unavailable' : new Date(offer.expiresAt).toLocaleString()}.
          </p>
          <button
            disabled={disabled}
            onClick={() => {
              control({
                action: 'claimRaid',
                transferId: offer.id,
                transferVersion: offer.version,
              });
            }}
          >
            Request historical adoption from {offer.sourceLabel}
          </button>
        </section>
      ))}
      {invitations.map((invite) => (
        <label key={invite.id}>
          Copy invitation for the original destination · earlier raid{' '}
          {new Date(invite.createdAt).toLocaleString()}
          <input
            readOnly
            aria-label={`Historical raid invitation ${invite.id}`}
            value={`${location.origin}/controller#claim=${invite.id}`}
          />
          <span>
            Only the original destination can adopt after connecting Twitch. The link grants no
            authority.
          </span>
        </label>
      ))}
    </section>
  );
}
