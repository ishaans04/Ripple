import { renderToStaticMarkup } from 'react-dom/server';
import { founderShell } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { ShellRenderer } from './ShellRenderer.tsx';

describe('versioned shell renderer', () => {
  it('renders the authored shell and constrained markings without executable content', () => {
    for (const patternId of ['plain', 'bands', 'dots'] as const) {
      const markup = renderToStaticMarkup(
        <ShellRenderer
          part={{ ...founderShell, marking: { ...founderShell.marking, patternId } }}
        />,
      );
      expect(markup).toContain('data-renderer="shell-v1"');
      expect(markup).not.toMatch(/<script|<foreignObject|<image/);
    }
  });
  it('shows an unsupported-version error rather than rewriting historical art', () => {
    expect(
      renderToStaticMarkup(<ShellRenderer part={founderShell} rendererVersion="shell-v9" />),
    ).toContain('unsupported');
  });
  it('exposes editable drawings as a labelled group so their handles stay reachable', () => {
    const editable = renderToStaticMarkup(
        <ShellRenderer part={founderShell} interactive label="Shell editor" />,
      ),
      still = renderToStaticMarkup(<ShellRenderer part={founderShell} />);
    expect(editable).toContain('role="group"');
    expect(editable).toContain('aria-label="Shell editor"');
    expect(still).toContain('role="img"');
  });
});
