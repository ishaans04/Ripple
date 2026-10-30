import { resolve } from 'node:path';
import { expectAccessible } from './axe.ts';
import { test, expect, type Page } from '@playwright/test';
import {
  defaultStudioSettings,
  founderShell,
  type StudioState,
  type StudioView,
} from '@ripple/contracts';
import { candidateRuleset, createStudioChallenge } from '@ripple/engine';

const world = '22222222-2222-4222-8222-222222222222',
  channel = '11111111-1111-4111-8111-111111111111',
  session = '33333333-3333-4333-8333-333333333333',
  organism = '44444444-4444-4444-8444-444444444444',
  hash = 'a'.repeat(64);
const challenge = createStudioChallenge(
  {
    worldId: world,
    studioSessionId: session,
    baseOrganismId: organism,
    baseOrganismVersion: 2,
    genome: candidateRuleset.genome.founder,
    baseAppearanceHash: null,
    targetMutationSlot: 3,
  },
  candidateRuleset,
);
const finalist = {
  schemaVersion: 1 as const,
  worldId: world,
  studioSessionId: session,
  baseOrganismId: organism,
  baseOrganismVersion: 2,
  mutationTemplateId: challenge.mutationTemplateIds[0] ?? 'cosmetic-only',
  rendererVersion: 'shell-v1' as const,
  part: { ...founderShell, parameters: { width: 700, height: 500, curvature: 400 } },
};

function state(
  phase: NonNullable<StudioView['session']>['phase'],
  extra: Partial<NonNullable<StudioView['session']>> = {},
): StudioState {
  const now = Date.now();
  return {
    worldId: world,
    channelId: channel,
    label: 'Synthetic browser channel',
    serverTimeMs: now,
    challenge,
    organism: {
      name: 'Tidepool',
      genome: candidateRuleset.genome.founder,
      appearance: { kind: 'founder', part: founderShell },
    },
    studio: {
      enabled: true,
      availability: { state: 'REST', source: 'manual', bridgeStale: false },
      session: {
        id: session,
        phase,
        version: 1,
        trigger: 'manual',
        cosmeticOnly: false,
        challenge: {
          templates: [...challenge.mutationTemplateIds],
          genome: challenge.genome,
          targetMutationSlot: 3,
        },
        creationCloseAtMs: phase === 'CREATING' ? now + 240_000 : null,
        votingCloseAtMs: phase === 'VOTING' ? now + 40_000 : null,
        reviewExpiresAtMs: null,
        accepted: 2,
        maxProposals: defaultStudioSettings.maxProposals,
        finalists: [],
        counts: [],
        selection: null,
        pending: null,
        outcome: null,
        ...extra,
      },
    },
  };
}

async function mockLive(page: Page, current: { value: StudioState | 'offline' }) {
  const posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  let operation: string | null = null;
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route(`**/api/studios/${session}`, (route) =>
    current.value === 'offline'
      ? route.abort('internetdisconnected')
      : route.fulfill({ json: current.value }),
  );
  await page.route('**/api/artist/status**', (route) =>
    route.fulfill({
      json: {
        signedIn: true,
        available: true,
        login: 'shell_maker',
        csrfToken: 'artist-csrf',
        proposals: [],
        lastResult:
          operation === null ? null : { operationId: operation, code: 'APPLIED', detail: {} },
      },
    }),
  );
  await page.route(`**/api/studios/${session}/proposals`, async (route) => {
    const request = route.request();
    operation = request.headers()['idempotency-key'] ?? null;
    posts.push({ url: request.url(), body: request.postDataJSON(), headers: request.headers() });
    await route.fulfill({
      status: 202,
      json: { operationId: operation, sequence: 9, duplicate: false },
    });
  });
  return posts;
}

async function installHandFixture(page: Page) {
  await page.route('**/test-hand.jpg', (route) =>
    route.fulfill({ path: resolve('tests/fixtures/right_hands.jpg'), contentType: 'image/jpeg' }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: (constraints: MediaStreamConstraints) => {
        if (constraints.audio !== false)
          return Promise.reject(new Error('Microphone must never be requested'));
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        canvas.getContext('2d')?.fillRect(0, 0, 640, 480);
        return Promise.resolve(canvas.captureStream(10));
      },
    });
    class FixtureWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror = null;
      frames = 0;
      postMessage(message: { type: string; bitmap?: ImageBitmap }) {
        if (message.type === 'initialize') {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
          return;
        }
        message.bitmap?.close();
        this.frames += 1;
        const x = this.frames <= 5 ? 810 : 990;
        const landmarks = Array.from({ length: 21 }, () => ({ x: 0.2, y: 0.5 }));
        landmarks[0] = { x: 0.2, y: 0.8 };
        landmarks[8] = { x: 1 - x / 1000, y: 0.5 };
        landmarks[4] = { x: 1 - x / 1000 + 0.02, y: 0.5 };
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: 'result',
              inferenceMs: 1,
              hands: this.frames < 35 ? [{ landmarks, confidence: 0.99 }] : [],
            },
          }),
        );
      }
      terminate() {
        this.onmessage = null;
      }
    }
    Object.defineProperty(window, 'Worker', { value: FixtureWorker });
  });
}

async function submit(page: Page) {
  await page.getByRole('button', { name: 'Review and submit' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('checkbox', { name: /Credit me by my Twitch name/ }).check();
  await page.getByRole('button', { name: 'Submit proposal' }).click();
}

test('hand and pointer artists submit identical bounded proposals only after confirmation', async ({
  page,
  context,
}) => {
  await installHandFixture(page);
  const current = { value: state('CREATING') as StudioState | 'offline' };
  const posts = await mockLive(page, current);
  await page.goto(`/studio?s=${session}`);
  await expect(page.getByText('Live studio')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Creation is open' })).toContainText(
    'Time remaining: 4:',
  );
  await expect(page.getByText('Signed in as shell_maker.')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  await expect(page.getByTestId('hand-status')).toContainText('No hand detected');
  // Tracking loss and editing never stream drafts or submit on their own.
  expect(posts).toEqual([]);
  await submit(page);
  await expect(page.getByText('Your proposal is in.')).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]?.headers['x-csrf-token']).toBe('artist-csrf');
  const byHand = posts[0]?.body as { blueprint: unknown; creditOptIn: boolean };
  expect(byHand.creditOptIn).toBe(true);

  const pointer = await context.newPage();
  const pointerPosts = await mockLive(pointer, current);
  await pointer.goto(`/studio?s=${session}`);
  await pointer.getByRole('button', { name: 'Reset shell' }).click();
  await pointer.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await pointer.keyboard.press('End');
  await submit(pointer);
  await expect(pointer.getByText('Your proposal is in.')).toBeVisible();
  expect((pointerPosts[0]?.body as { blueprint: unknown }).blueprint).toEqual(byHand.blueprint);
  await pointer.close();
});

test('voting, incubation and hatch states recover after a lost connection without losing the draft', async ({
  page,
}) => {
  const current = { value: state('CREATING') as StudioState | 'offline' };
  await mockLive(page, current);
  await page.goto(`/studio?s=${session}`);
  await page.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('300');
  current.value = state('VOTING', {
    finalists: [
      {
        index: 1,
        hash,
        template: finalist.mutationTemplateId,
        blueprint: finalist,
        credit: 'shell_maker',
      },
    ],
    counts: [4, 1],
  });
  const finalists = page.getByRole('list', { name: 'Finalists' });
  await expect(finalists).toContainText('!ripple 1');
  await expect(finalists).toContainText('4 votes');
  await expect(finalists).toContainText('!ripple 2 · Keep current · 1 votes');
  await expect(page.getByText('This studio has closed, so the camera is off.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable hand controls' })).toBeDisabled();
  current.value = 'offline';
  await expect(page.getByRole('alert')).toContainText('Connection lost');
  current.value = state('PENDING_HATCH', {
    finalists: [
      {
        index: 1,
        hash,
        template: finalist.mutationTemplateId,
        blueprint: finalist,
        credit: 'shell_maker',
      },
    ],
    selection: { kind: 'design', reason: null, finalistIndex: 1 },
    pending: {
      hash,
      template: finalist.mutationTemplateId,
      blueprint: finalist,
      credit: 'shell_maker',
      message: 'Community design selected. Hatches after the current round.',
    },
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText(/has\s+not been applied yet/)).toBeVisible();
  current.value = state('COMPLETED', { outcome: { reason: 'hatched' } });
  await expect(page.getByText('The community design hatched.')).toBeVisible();
  // The local draft survived every reconnect.
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('300');
  await expectAccessible(page);
});

test('without live sign-in the studio stays an honest local editor with no submission', async ({
  page,
}) => {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') posts.push(request.url());
  });
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: false } }));
  await page.route(`**/api/studios/${session}`, (route) =>
    route.fulfill({ json: state('CREATING') }),
  );
  await page.goto(`/studio?s=${session}`);
  await expect(
    page.getByText('Proposal sign-in is not available on this installation.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Review and submit' }).click();
  await expect(page.getByRole('button', { name: 'Submit proposal' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download design' })).toBeEnabled();
  expect(posts).toEqual([]);
});
