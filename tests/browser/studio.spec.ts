import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    fixtureStops: number;
    fixtureRequests: number;
    permissionRequests: number;
  }
}

async function exportDesign(page: Page): Promise<unknown> {
  await page.getByRole('button', { name: 'Save design' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download design' }).click();
  const path = await (await saved).path();
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function installVideoFixture(page: Page): Promise<void> {
  await page.route('**/test-hand.jpg', async (route) => {
    await route.fulfill({
      path: resolve('tests/fixtures/right_hands.jpg'),
      contentType: 'image/jpeg',
    });
  });
  await page.addInitScript(() => {
    const state = window as Window & { fixtureStops: number; fixtureRequests: number };
    state.fixtureStops = 0;
    state.fixtureRequests = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        state.fixtureRequests += 1;
        if (constraints.audio !== false) throw new Error('Microphone must never be requested');
        const image = new Image();
        image.src = '/test-hand.jpg';
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('Canvas unavailable');
        const draw = () => {
          context.drawImage(image, 0, 0, 640, 480);
        };
        draw();
        const timer = setInterval(draw, 100);
        const stream = canvas.captureStream(10);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            clearInterval(timer);
            state.fixtureStops += 1;
            sessionStorage.setItem('fixture-stopped', 'yes');
            stop();
          };
        }
        return stream;
      },
    });
  });
}

test('local editor recovers a draft, supports keyboard undo, and requires confirmation', async ({
  page,
}, info) => {
  const writes: string[] = [];
  const visionRequests: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
    if (request.url().includes('/vision/')) visionRequests.push(request.url());
  });
  const response = await page.goto('/studio');
  expect(response?.headers()['permissions-policy']).toBe('camera=(self), microphone=()');
  await expect(page.getByRole('heading', { name: 'Shape what travels next.' })).toBeVisible();
  await page.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'bands', exact: true }).click();
  await expect(page.getByText('Draft saved on this device.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  await expect(page.getByRole('button', { name: 'bands', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('slider', { name: 'Shell width control', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('840');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  const design = await exportDesign(page);
  await page.screenshot({ path: `test-results/studio-${info.project.name}.png`, fullPage: true });
  expect(design).toMatchObject({
    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    blueprint: { part: { parameters: { width: 850 }, marking: { patternId: 'bands' } } },
  });
  expect(writes).toEqual([]);
  expect(visionRequests).toEqual([]);
});

test('camera denial keeps pointer editing and does not re-prompt on editor changes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as Window & { permissionRequests: number };
    state.permissionRequests = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: () => {
        state.permissionRequests += 1;
        return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
      },
    });
  });
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByTestId('camera-status')).toContainText('permission was denied');
  await page.getByRole('slider', { name: 'Shell height', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('slider', { name: 'Shell height', exact: true })).toHaveValue('750');
  expect(
    await page.evaluate(
      () => (window as Window & { permissionRequests: number }).permissionRequests,
    ),
  ).toBe(1);
});

test('real model detects hands in a worker under production CSP and releases the camera', async ({
  page,
}) => {
  await installVideoFixture(page);
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text());
  });
  await page.goto('/studio');
  const worker = page.waitForEvent('worker');
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  expect((await worker).url()).toContain('/assets/hand-worker-');
  await expect(page.getByTestId('camera-status')).toContainText('Camera on', { timeout: 45000 });
  await expect(page.getByTestId('hand-status')).toContainText(
    /Hand detected|Point grabbed|Two hands detected/,
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: 'Turn camera off' }).click();
  await expect(page.getByTestId('camera-status')).toHaveText('Camera off');
  expect(
    await page.evaluate(() => (window as Window & { fixtureStops: number }).fixtureStops),
  ).toBe(1);
  expect(violations).toEqual([]);
});

test('model failure preserves the draft and gives working non-camera controls', async ({
  page,
}) => {
  await installVideoFixture(page);
  await page.route('**/vision/hand_landmarker_v1.task', async (route) => {
    await route.abort();
  });
  await page.goto('/studio');
  await page.getByRole('button', { name: 'dots', exact: true }).click();
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByTestId('camera-status')).toContainText(/could not load|could not start/);
  await expect(page.getByRole('button', { name: 'dots', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  expect(
    await page.evaluate(() => (window as Window & { fixtureStops: number }).fixtureStops),
  ).toBe(1);
});

test('hand actions and pointer actions export identical bounded blueprints; loss never submits', async ({
  page,
  context,
}) => {
  await installVideoFixture(page);
  await page.addInitScript(() => {
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
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  await expect(page.getByTestId('hand-status')).toContainText('No hand detected');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const byHand = await exportDesign(page);
  await page.getByRole('button', { name: 'Turn camera off' }).click();
  const pointer = await context.newPage();
  await pointer.goto('/studio');
  await pointer.getByRole('button', { name: 'Reset shell' }).click();
  await pointer.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await pointer.keyboard.press('End');
  const byPointer = await exportDesign(pointer);
  expect(byHand).toEqual(byPointer);
  await pointer.close();
});

test('touch drag and narrow layout keep the same bounded controls', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/studio');
  const handle = page.getByRole('slider', { name: 'Shell width control', exact: true });
  await handle.scrollIntoViewIfNeeded();
  await expect(handle).toBeInViewport();
  const box = await handle.boundingBox();
  if (box === null) throw new Error('Missing shell handle');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const endX = Math.min(x + 100, (page.viewportSize()?.width ?? 390) - 1);
  // Raw CDP touch dispatch does not perform Playwright's hit-target checks.
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[role="slider"]')?.getAttribute('aria-label'),
      { x, y },
    ),
  ).toBe('Shell width control');
  const session = await context.newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: endX, y, id: 1 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
