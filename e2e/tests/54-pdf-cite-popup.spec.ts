import { test, expect } from '../fixtures';
import { createProject, openProject, expectTypesetOk, cleanup } from './helpers';

const BIB = `@article{turing1950,
  author = {Turing, Alan M.},
  title = {Computing Machinery and Intelligence},
  journal = {Mind},
  year = {1950}
}
`;

// hyperref turns the \cite number into a Link annotation whose named
// destination is cite.turing1950; the pane reads that to show the preview.
const DOC = [
  '\\documentclass{article}',
  '\\usepackage{hyperref}',
  '\\begin{document}',
  'As shown by Turing~\\cite{turing1950}, machines can think.',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');

/** The rendered PDF's cite numbers open a reference preview on hover/click. */
test.describe('PDF cite popup', () => {
  test('hovering a cite number shows the reference, click pins it', async ({ page, request }) => {
    const id = await createProject(request, 'Cite Popup');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'refs.bib', content: BIB } });
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: DOC } });
      await openProject(page, id);
      await expectTypesetOk(page);

      // The hotspot is laid over the cite number once its page rasterizes.
      const hot = page.getByTestId('pdf-cite-link-turing1950');
      await expect(hot).toBeVisible({ timeout: 20_000 });

      // Hover: the preview appears with the paper title and author.
      await hot.hover();
      const pop = page.getByTestId('pdf-cite-pop');
      await expect(pop).toBeVisible({ timeout: 5_000 });
      await expect(pop).toContainText('Computing Machinery and Intelligence');
      await expect(pop).toContainText('Turing');

      // Leaving the hotspot dismisses a hover popup.
      await page.getByTestId('pdf-pane').hover({ position: { x: 5, y: 5 } });
      await expect(pop).toHaveCount(0);

      // Click pins it open; it survives a move away, and Escape dismisses it.
      await hot.click();
      await expect(page.getByTestId('pdf-cite-pop')).toBeVisible();
      await page.getByTestId('pdf-pane').hover({ position: { x: 5, y: 5 } });
      await expect(page.getByTestId('pdf-cite-pop')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pdf-cite-pop')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });
});
