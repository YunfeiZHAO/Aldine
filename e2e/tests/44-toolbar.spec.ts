import { test, expect } from '../fixtures';
import { createProject, createPaperProject, openProject, expectTypesetOk, cleanup } from './helpers';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The editor's top bar keeps one control per job: the branch pill carries the
 * git controls, Share carries the downloads, settings carries the engine, and
 * the preview header holds what belongs to the PDF.
 */
test.describe('editor toolbar', () => {
  test('one branch pill; publishing lives in its menu, downloads in Share', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Toolbar Pill');
    try {
      await openProject(page, id);
      await expectTypesetOk(page);
      await expect(page.getByTestId('branch-menu')).toHaveCount(1);
      await expect(page.getByTestId('remote-publish-open')).toHaveCount(0);
      await expect(page.getByTestId('engine-select')).toHaveCount(0);
      await expect(page.getByTestId('download-pdf')).toHaveCount(0);

      await page.getByTestId('branch-menu').click();
      await page.getByTestId('remote-publish-open').click();
      await expect(page.getByTestId('remote-publish')).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId('share-project').click();
      await expect(page.getByTestId('download-pdf')).toHaveAttribute('href', /\/api\/projects\/.+\/output/);
      await expect(page.getByTestId('download-zip')).toHaveAttribute('href', /\/archive\?branch=main$/);
      await page.getByTestId('share-close').click();

      // the preview header holds the PDF's own controls, and no title
      const preview = page.locator('.pane--preview .pane__header');
      await expect(preview.getByTestId('jump-to-pdf')).toBeVisible();
      await expect(preview.getByTestId('word-count')).toContainText(/\d+ words/);
      await expect(preview).not.toContainText('Preview');
    } finally { await cleanup(request, id); }
  });

  test('the appearance button toggles the theme and the rendered PDF follows it', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Toolbar Appearance');
    try {
      // Start from an explicit light choice so the test is independent of the
      // system colour scheme the runner happens to report.
      await openProject(page, id);
      await page.evaluate(() => localStorage.setItem('aldine.theme', 'light'));
      await page.reload();
      await expectTypesetOk(page);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');

      const firstPage = page.locator('canvas.pdf-page').first();
      const filterOf = () => firstPage.evaluate((el) => getComputedStyle(el).filter);
      // Light: the pages are shown as printed — no inversion.
      expect(await filterOf()).toBe('none');

      // The button lives in the toolbar and opens the three-choice menu.
      await page.getByTestId('theme-toggle').click();
      await page.getByTestId('appearance-dark').click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
      // Dark: the rendered page carries the invert+hue-rotate filter.
      await expect.poll(filterOf).not.toBe('none');

      await page.getByTestId('theme-toggle').click();
      await page.getByTestId('appearance-light').click();
      await expect.poll(filterOf).toBe('none');
    } finally { await cleanup(request, id); }
  });

  test('the comment shortcut opens the composer on the selection', async ({ page, request }) => {
    const id = await createProject(request, 'Comment Shortcut');
    try {
      await request.put(`/api/projects/${id}/file`, { data: { branch: 'main', path: 'main.tex', content: 'PLACEHOLDER needs a word.\n' } });
      await openProject(page, id);
      await expect(page.locator('.cm-content')).toContainText('PLACEHOLDER', { timeout: 10_000 });
      await expect(page.getByTestId('add-comment')).toContainText(/⇧⌘M|Ctrl\+Shift\+M/);

      const line = await page.locator('.cm-line').first().boundingBox();
      await page.mouse.dblclick(line!.x + 30, line!.y + line!.height / 2);
      await expect.poll(async () => await page.evaluate(() => window.getSelection()?.toString())).toBe('PLACEHOLDER');
      await page.keyboard.press(`${mod}+Shift+m`);
      await expect(page.getByTestId('comment-composer')).toBeVisible();
    } finally { await cleanup(request, id); }
  });

  test('plugin panels share one More tab', async ({ page, request }) => {
    const id = await createProject(request, 'More Tab');
    try {
      await openProject(page, id);
      const more = page.getByTestId('tab-more');
      await expect(more).toBeVisible({ timeout: 15_000 });
      await expect(more).toHaveText(/^More/);
      await more.click();
      await expect(page.getByTestId('tab-more-menu')).toBeVisible();
      await page.getByTestId('tab-plugin:zotero').click();
      await expect(page.getByTestId('tab-more-menu')).toHaveCount(0);
      await expect(page.getByTestId('zotero-panel')).toBeVisible();
      // the tab names the panel it shows
      await expect(more).toHaveText(/^Zotero/);
      await expect(more).toHaveAttribute('aria-selected', 'true');
    } finally { await cleanup(request, id); }
  });
});
