import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  blueprintSchema,
  defaultStudioSettings,
  studioSettingsSchema,
  type ChannelView,
  type StudioSettings,
} from '@ripple/contracts';
import { liveRequest } from './api.ts';
import { ShellRenderer } from '../studio/ShellRenderer.tsx';
import { StudioStatus, studioTemplateText } from '../studio/StudioStatus.tsx';
import styles from './Controller.module.css';

const moderationSchema = z.object({
  settings: studioSettingsSchema.nullable(),
  bridge: z.object({
    issued: z.boolean(),
    lastSeenAt: z.string().nullable(),
    scene: z.string().nullable(),
    stale: z.boolean(),
  }),
  proposals: z.array(
    z.object({
      id: z.uuid(),
      artistKey: z.string(),
      credit: z.string(),
      creditOptIn: z.boolean(),
      hash: z.string(),
      revision: z.int(),
      blueprint: blueprintSchema,
    }),
  ),
  blocks: z.array(z.string()),
});
type Moderation = z.infer<typeof moderationSchema>;
const scenes = (value: string) =>
  value
    .split(',')
    .map((scene) => scene.trim())
    .filter((scene) => scene.length > 0);

/** Broadcaster studio settings, manual break controls, review, moderation and the OBS bridge. */
export function StudioCard({
  channel,
  disabled,
  csrfToken,
  control,
}: {
  channel: ChannelView;
  disabled: boolean;
  csrfToken: string | undefined;
  control: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const [moderation, setModeration] = useState<Moderation | null>(null);
  const [draft, setDraft] = useState<StudioSettings | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(tick);
    };
  }, []);
  useEffect(() => {
    const lifetime = { stopped: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = moderationSchema.parse(await liveRequest('/api/controller/studio'));
        if (!lifetime.stopped) setModeration(next);
      } catch {
        /* The rest of the controller keeps working; moderation retries. */
      }
      if (!lifetime.stopped) timer = setTimeout(() => void load(), 3000);
    }
    void load();
    return () => {
      lifetime.stopped = true;
      clearTimeout(timer);
    };
  }, []);
  const studio = channel.studio;
  const session = studio?.session ?? null;
  const settings = draft ?? moderation?.settings ?? defaultStudioSettings;
  const edit = (change: Partial<StudioSettings>) => {
    setDraft({ ...settings, ...change });
  };
  const valid = studioSettingsSchema.safeParse(settings);
  const holding =
    session !== null && ['OPENING', 'CREATING', 'VOTING', 'REVIEW'].includes(session.phase);
  const winner =
    session?.phase === 'REVIEW' &&
    session.selection !== null &&
    session.selection.finalistIndex !== null
      ? session.finalists[session.selection.finalistIndex - 1]
      : undefined;
  async function createBridge() {
    if (csrfToken === undefined) return;
    try {
      const result = z
        .object({ worldId: z.uuid(), channelId: z.uuid(), capability: z.string() })
        .parse(
          await liveRequest(`/api/channels/${channel.channelId}/studio/bridge-capability`, {
            method: 'POST',
            headers: { 'x-csrf-token': csrfToken },
          }),
        );
      setBridgeUrl(`${location.origin}/bridge#${new URLSearchParams(result).toString()}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Bridge link failed.');
    }
  }
  return (
    <section className={styles.panel} aria-label="Cocoon Studio controls">
      <h2>Cocoon Studio</h2>
      <p>
        Availability: {studio?.availability.state ?? 'ACTIVE'}
        {studio?.availability.source !== null && studio?.availability.source !== undefined
          ? ` (from ${studio.availability.source})`
          : ''}
        {(studio?.availability.bridgeStale === true || moderation?.bridge.stale === true) &&
          ' · OBS bridge signal is stale; Ripple does not assume you returned.'}
      </p>
      <div className={styles.actions}>
        <button
          disabled={disabled || studio?.enabled !== true || holding}
          onClick={() => {
            control('studio/start');
          }}
        >
          Start break studio
        </button>
        <button
          disabled={disabled || studio?.enabled !== true}
          onClick={() => {
            control('studio/stop');
          }}
        >
          End break
        </button>
      </div>
      {session !== null && (
        <>
          <StudioStatus channel={channel} now={now} showLink />
          <p>
            Studio page:{' '}
            <a href={`/studio?s=${session.id}`}>{`${location.origin}/studio?s=${session.id}`}</a>
          </p>
        </>
      )}
      {winner !== undefined && session !== null && (
        <section aria-label="Studio review">
          <h3>Review the community design</h3>
          <ShellRenderer part={winner.blueprint.part} label="Winning community design" />
          <p>
            Trade-off: {studioTemplateText[winner.template]} · credit: {winner.credit}. Approval
            hatches it after the current round; Keep current changes nothing.
            {session.reviewExpiresAtMs !== null &&
              ` Review closes in ${Math.max(0, Math.ceil((session.reviewExpiresAtMs - now) / 60000))} min.`}
          </p>
          <div className={styles.actions}>
            <button
              disabled={disabled}
              onClick={() => {
                control(`/api/studios/${session.id}/review`, {
                  sessionVersion: session.version,
                  decision: 'approve',
                });
              }}
            >
              Approve design
            </button>
            <button
              disabled={disabled}
              onClick={() => {
                control(`/api/studios/${session.id}/review`, {
                  sessionVersion: session.version,
                  decision: 'keep',
                });
              }}
            >
              Keep current
            </button>
          </div>
        </section>
      )}
      {session?.phase === 'PENDING_HATCH' && (
        <button
          disabled={disabled || channel.round?.studioHatch !== undefined}
          onClick={() => {
            control(`/api/studios/${session.id}/release`, { sessionVersion: session.version });
          }}
        >
          Release pending design
        </button>
      )}
      {session?.phase === 'CREATING' && moderation !== null && (
        <section aria-label="Studio proposals">
          <h3>Proposals ({moderation.proposals.length})</h3>
          <ul className={styles.proposals}>
            {moderation.proposals.map((proposal) => (
              <li key={proposal.id}>
                <ShellRenderer
                  part={proposal.blueprint.part}
                  label={`Proposal by ${proposal.credit}`}
                />
                <span>
                  {proposal.credit} · {studioTemplateText[proposal.blueprint.mutationTemplateId]} ·
                  revision {proposal.revision}
                </span>
                <button
                  disabled={disabled}
                  onClick={() => {
                    control(`/api/studios/${session.id}/proposals/${proposal.id}/remove`);
                  }}
                >
                  Remove
                </button>
                <button
                  disabled={disabled}
                  onClick={() => {
                    control('studio/blocks', { artistKey: proposal.artistKey, blocked: true });
                  }}
                >
                  Block artist
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details>
        <summary>Studio settings</summary>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => {
              edit({ enabled: event.target.checked });
            }}
          />{' '}
          Enable Cocoon Studio for this channel
        </label>
        <label>
          Approval
          <select
            value={settings.approval}
            onChange={(event) => {
              edit({ approval: event.target.value === 'auto' ? 'auto' : 'review' });
            }}
          >
            <option value="review">I review every winning design</option>
            <option value="auto">Approve restricted templates automatically</option>
          </select>
        </label>
        <label>
          When I return during voting
          <select
            value={settings.returnDuringVoting}
            onChange={(event) => {
              edit({ returnDuringVoting: event.target.value === 'cancel' ? 'cancel' : 'finish' });
            }}
          >
            <option value="finish">Let chat finish the vote</option>
            <option value="cancel">Cancel the vote</option>
          </select>
        </label>
        <label>
          If no shell mutation is legal
          <select
            value={settings.cosmeticPolicy}
            onChange={(event) => {
              edit({ cosmeticPolicy: event.target.value === 'defer' ? 'defer' : 'offer' });
            }}
          >
            <option value="offer">Offer a labelled appearance-only studio</option>
            <option value="defer">Defer the studio</option>
          </select>
        </label>
        {(
          [
            ['creationMs', 'Creation minutes', 60_000],
            ['votingMs', 'Voting seconds', 1000],
            ['reviewMs', 'Review minutes', 60_000],
            ['replaceCooldownMs', 'Replacement cooldown seconds', 1000],
          ] as const
        ).map(([key, label, unit]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              value={settings[key] / unit}
              onChange={(event) => {
                edit({ [key]: Math.round(Number(event.target.value) * unit) });
              }}
            />
          </label>
        ))}
        <label>
          Proposal limit
          <input
            type="number"
            value={settings.maxProposals}
            onChange={(event) => {
              edit({ maxProposals: Math.round(Number(event.target.value)) });
            }}
          />
        </label>
        <label>
          OBS break scenes (comma separated)
          <input
            value={settings.breakScenes.join(', ')}
            onChange={(event) => {
              edit({ breakScenes: scenes(event.target.value) });
            }}
          />
        </label>
        <label>
          OBS active scenes (comma separated)
          <input
            value={settings.activeScenes.join(', ')}
            onChange={(event) => {
              edit({ activeScenes: scenes(event.target.value) });
            }}
          />
        </label>
        {!valid.success && <p role="alert">These settings are outside the supported limits.</p>}
        <button
          disabled={disabled || !valid.success || draft === null}
          onClick={() => {
            if (!valid.success) return;
            control('studio/settings', { settings: valid.data });
            setDraft(null);
          }}
        >
          Save studio settings
        </button>
      </details>
      <details>
        <summary>OBS scene bridge</summary>
        <p>
          Add the bridge as an OBS browser source with page permission to read the current scene. It
          can only report availability for this channel. Manual controls always work without it.
        </p>
        <p>
          {moderation?.bridge.issued === true
            ? `Bridge ${moderation.bridge.stale ? 'stale' : 'reporting'}${moderation.bridge.scene === null ? '' : ` · last scene "${moderation.bridge.scene}"`}.`
            : 'No bridge link issued.'}
        </p>
        <button disabled={disabled} onClick={() => void createBridge()}>
          Create bridge link (revokes the previous one)
        </button>
        {bridgeUrl !== '' && (
          <p>
            Bridge source URL (shown once): <code>{bridgeUrl}</code>
          </p>
        )}
        {error !== '' && <p role="alert">{error}</p>}
      </details>
    </section>
  );
}
