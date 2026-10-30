import { useEffect, useState } from 'react';
import { SceneReporter, type BridgeSignal } from './reporter.ts';

interface ObsStudio {
  getCurrentScene?: (callback: (scene: { name: string } | null) => void) => void;
}
declare global {
  interface Window {
    obsstudio?: ObsStudio;
  }
}
const HEARTBEAT_MS = 30_000;

function credentials(): { channelId: string; capability: string } | null {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const channelId = hash.get('channelId'),
    capability = hash.get('capability');
  return channelId !== null &&
    /^[0-9a-f-]{36}$/i.test(channelId) &&
    capability !== null &&
    /^[A-Za-z0-9_-]{43}$/.test(capability)
    ? { channelId, capability }
    : null;
}

/**
 * The OBS browser-source bridge. Its capability may only report availability signals for one
 * channel; it never reads the overlay, game state or Twitch credentials.
 */
export default function Bridge() {
  const [status, setStatus] = useState(() =>
    credentials() === null
      ? 'This bridge link is incomplete. Create a new one in the Ripple controller.'
      : window.obsstudio?.getCurrentScene === undefined
        ? 'Add this page as an OBS browser source and allow it to read the current scene. Manual controls still work without it.'
        : 'Starting the Ripple studio bridge…',
  );
  useEffect(() => {
    const scope = credentials();
    const getCurrentScene = window.obsstudio?.getCurrentScene;
    if (scope === null || getCurrentScene === undefined) return;
    const send = async (signal: BridgeSignal): Promise<boolean> => {
      try {
        const response = await fetch(`/api/channels/${scope.channelId}/availability`, {
          method: 'POST',
          keepalive: true,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${scope.capability}`,
          },
          body: JSON.stringify(signal),
        });
        setStatus(
          response.ok
            ? 'Reporting configured break and active scenes to Ripple.'
            : response.status === 409
              ? 'Cocoon Studio is not enabled for this channel; scenes are not reported.'
              : 'This bridge link was revoked. Create a new one in the controller.',
        );
        return response.ok;
      } catch {
        setStatus('Connection lost. The bridge will reconcile the current scene when it returns.');
        return false;
      }
    };
    const reporter = new SceneReporter(send, {
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (id) => {
        window.clearTimeout(id);
      },
    });
    const reconcile = () => {
      getCurrentScene((scene) => {
        reporter.reconcile(scene?.name ?? null);
      });
    };
    const changed = (event: Event) => {
      const name = (event as CustomEvent<{ name?: unknown }>).detail.name;
      if (typeof name === 'string') reporter.sceneChanged(name);
    };
    const visibility = (event: Event) => {
      const visible = (event as CustomEvent<{ visible?: unknown }>).detail.visible;
      if (visible === false) reporter.hidden();
      else if (visible === true) reconcile();
    };
    const pageHidden = () => {
      reporter.hidden();
    };
    reconcile();
    window.addEventListener('obsSceneChanged', changed);
    window.addEventListener('obsSourceVisibleChanged', visibility);
    window.addEventListener('online', reconcile);
    window.addEventListener('pagehide', pageHidden);
    const heartbeat = window.setInterval(() => {
      reporter.heartbeat();
    }, HEARTBEAT_MS);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener('obsSceneChanged', changed);
      window.removeEventListener('obsSourceVisibleChanged', visibility);
      window.removeEventListener('online', reconcile);
      window.removeEventListener('pagehide', pageHidden);
    };
  }, []);
  return (
    <main aria-label="Ripple studio bridge">
      <p role="status">{status}</p>
    </main>
  );
}
