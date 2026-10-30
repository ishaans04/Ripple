import { test, expect } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { cpus, totalmem, release } from 'node:os';
import { installVideoFixture } from './vision-fixture.ts';
import type { HandWorkerReply } from '../../apps/web/src/studio/handProtocol.ts';

declare global {
  interface Window {
    releaseVision: {
      frames: number;
      inFlight: number;
      maxInFlight: number;
      inference: number[];
      inputPaint: number[];
    };
  }
}
test('real inference keeps bounded frames and responsive editing under a declared slow CPU', async ({
  page,
  context,
}, info) => {
  await installVideoFixture(page);
  await page.addInitScript(() => {
    window.releaseVision = {
      frames: 0,
      inFlight: 0,
      maxInFlight: 0,
      inference: [],
      inputPaint: [],
    };
    document.addEventListener('input', (event) =>
      requestAnimationFrame(() =>
        window.releaseVision.inputPaint.push(performance.now() - event.timeStamp),
      ),
    );
    const NativeWorker = window.Worker;
    class ObservedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<HandWorkerReply>) => {
          if (event.data.type === 'result') {
            window.releaseVision.inFlight--;
            window.releaseVision.inference.push(event.data.inferenceMs);
          }
        });
      }
      override postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        if ((message as { type?: string }).type === 'frame') {
          window.releaseVision.frames++;
          window.releaseVision.inFlight++;
          window.releaseVision.maxInFlight = Math.max(
            window.releaseVision.maxInFlight,
            window.releaseVision.inFlight,
          );
        }
        super.postMessage(message, Array.isArray(transfer) ? transfer : (transfer.transfer ?? []));
      }
    }
    window.Worker = ObservedWorker;
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByTestId('hand-status')).toContainText(
    /Hand detected|Two hands detected|Point grabbed/,
    { timeout: 30000 },
  );
  await expect.poll(() => page.evaluate(() => window.releaseVision.frames)).toBeGreaterThan(3);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  const frameSamples = page.evaluate(async () => {
    const gaps: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 90; i++)
      await new Promise<void>((done) =>
        requestAnimationFrame((now) => {
          gaps.push(now - previous);
          previous = now;
          done();
        }),
      );
    return gaps;
  });
  const input: number[] = [];
  const slider = page.getByRole('slider', { name: 'Shell width', exact: true });
  await slider.focus();
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    await slider.press(i % 2 ? 'Home' : 'End');
    await expect(slider).toHaveValue(i % 2 ? '300' : '850');
    input.push(performance.now() - start);
  }
  const gaps = await frameSamples,
    vision = await page.evaluate(() => window.releaseVision);
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)] ?? Infinity;
  const report = {
    syntheticVideo: true,
    physicalCamera: false,
    cpuSlowdown: 4,
    browser: info.project.name,
    environment: {
      browserVersion: context.browser()?.version(),
      node: process.version,
      os: release(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    inputRoundTripP95Ms: p95(input),
    inputToNextFrameP95Ms: p95(vision.inputPaint),
    animationFrameP95Ms: p95(gaps),
    inferenceP95Ms: p95(vision.inference),
    maxInFlight: vision.maxInFlight,
    frames: vision.frames,
    editingWrites: writes.length,
    limits:
      '4x CPU emulation on the declared Windows host; no claim about all physical low-end cameras/GPUs. InputRoundTrip includes Playwright transport; inputToNextFrame is measured inside the page.',
  };
  await mkdir('tmp', { recursive: true });
  await writeFile(
    `tmp/phase10-client-${info.project.name}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  expect(vision.maxInFlight).toBe(1);
  expect(writes).toEqual([]);
  expect(report.animationFrameP95Ms).toBeLessThan(150);
  expect(vision.inputPaint.length).toBe(12);
  expect(report.inputToNextFrameP95Ms).toBeLessThan(100);
  // Deterministic visibility event: browser automation cannot reliably occlude headless tabs.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.releaseVision.inFlight)).toBe(0);
  const hiddenFrames = await page.evaluate(() => window.releaseVision.frames);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.releaseVision.frames)).toBe(hiddenFrames);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => page.evaluate(() => window.releaseVision.frames))
    .toBeGreaterThan(hiddenFrames);
  await page.getByRole('button', { name: 'Turn camera off' }).click();
});

test('slow model delivery keeps a draft editable, and offline editing sends no design', async ({
  page,
  context,
}) => {
  await installVideoFixture(page);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/vision/hand_landmarker_v1.task', async (route) => {
    await blocked;
    await route.abort();
  });
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByTestId('camera-status')).toContainText(/loading/i);
  await page.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  release();
  await expect(page.getByTestId('camera-status')).toContainText(/could not load|could not start/);
  await context.setOffline(true);
  await page.getByRole('slider', { name: 'Shell width', exact: true }).press('Home');
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('300');
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('300');
});

test('an unsupported model payload fails visibly, releases the camera and keeps the draft', async ({
  page,
}) => {
  await installVideoFixture(page);
  await page.route('**/vision/hand_landmarker_v1.task', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: 'This is not a supported MediaPipe model.',
    }),
  );
  await page.goto('/studio');
  await page.getByRole('slider', { name: 'Shell width', exact: true }).focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Enable hand controls' }).click();
  await expect(page.getByTestId('camera-status')).toContainText(/could not load|could not start/);
  expect(await page.evaluate(() => window.fixtureStops)).toBe(1);
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('850');
  await page.getByRole('slider', { name: 'Shell width', exact: true }).press('Home');
  await expect(page.getByRole('slider', { name: 'Shell width', exact: true })).toHaveValue('300');
  expect(await page.evaluate(() => window.fixtureRequests)).toBe(1);
});
