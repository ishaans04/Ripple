import { test, expect } from '@playwright/test';
import { expectAccessible } from './axe.ts';
test('privacy explains actual retention and removal without requesting camera access', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Privacy and data deletion', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Artist identity', exact: true })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('30 days');
  await expect(page.getByRole('main')).toContainText('12 hours');
  await expect(page.getByRole('main')).toContainText('scoped pseudonyms');
  await expectAccessible(page);
});
