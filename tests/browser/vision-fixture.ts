import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
export async function installVideoFixture(page: Page): Promise<void> {
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
