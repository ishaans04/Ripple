import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.1 A/AA automated checks on the rendered page; failures list every rule and target. */
export async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    violations.map((item) => ({
      rule: item.id,
      impact: item.impact,
      targets: item.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}
