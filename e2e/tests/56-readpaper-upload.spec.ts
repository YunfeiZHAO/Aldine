import { test, expect } from '../fixtures';
import { createProject, openProject, cleanup } from './helpers';

const READER = 'http://reader.example.test';
const PDF = '%PDF-1.7\nReader upload test\n%%EOF';

test('choose a Reader filename and preserve it through sign-in and reconnect', async ({ page, request }) => {
  const id = await createProject(request, 'Reader paper');
  const uploads: string[] = [];
  let expireNext = false;
  try {
    const result = {
      ok: true, pdf: 'main.pdf', pdfUrl: `/api/projects/${id}/output?branch=main&path=main.pdf`,
      log: '', errors: [], durationMs: 1,
    };
    await page.route(`**/api/projects/${id}/compile*`, async (route) => {
      await route.fulfill({
        json: route.request().method() === 'POST'
          ? result
          : { running: false, result, finishedAt: Date.now(), agent: false },
      });
    });
    await page.route(`**/api/projects/${id}/output?**`, (route) =>
      route.fulfill({ contentType: 'application/pdf', body: PDF }));
    await page.route(`${READER}/**`, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'authorization, content-type',
            'Access-Control-Allow-Methods': 'POST',
          },
        });
      } else if (req.url().endsWith('/api/auth/login')) {
        expect(req.postDataJSON()).toEqual({ email: 'reader@example.test', password: 'test-password' });
        await route.fulfill({ json: { token: 'test-reader-session' } });
      } else {
        expect(req.url()).toBe(`${READER}/api/batch-upload`);
        const body = req.postDataBuffer()!.toString('utf8');
        expect(body).toContain('name="files"; filename="');
        expect(body).toContain(PDF);
        expect(body).toContain('name="on_conflict"\r\n\r\nreplace');
        expect(body).toContain('name="workspace_name"\r\n\r\nMy papers');
        uploads.push(body.match(/name="files"; filename="([^"]+)"/)![1]);
        const expired = expireNext;
        expireNext = false;
        await route.fulfill({
          status: expired ? 401 : 207,
          json: expired ? { detail: 'Session expired' } : { results: [{ status: 'created' }] },
        });
      }
    });
    await openProject(page, id);
    const upload = page.getByTestId('readpaper-upload');
    await expect(upload).toBeEnabled();

    await upload.click();
    const filename = page.getByTestId('readpaper-filename');
    const send = page.getByTestId('readpaper-send-confirm');
    await expect(filename).toHaveValue('Reader paper.pdf');
    await filename.fill('   ');
    await expect(send).toBeDisabled();
    await page.getByTestId('readpaper-send').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('readpaper-config')).toHaveCount(0);
    expect(uploads).toEqual([]);

    await upload.click();
    await filename.fill('Draft for review');
    await send.click();
    await expect(page.getByTestId('readpaper-config')).toBeVisible();
    await page.getByLabel('read_paper URL', { exact: true }).fill(READER);
    await page.getByLabel('Email', { exact: true }).fill('reader@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByLabel('Workspace name').fill('My papers');
    await page.getByTestId('readpaper-save').click();
    await expect.poll(() => uploads).toEqual(['Draft for review.pdf']);
    await expect(upload).toBeEnabled();

    await upload.click();
    await expect(filename).toHaveValue('Draft for review');
    await filename.fill('Final manuscript.PDF');
    await filename.press('Enter');
    await expect.poll(() => uploads).toEqual(['Draft for review.pdf', 'Final manuscript.PDF']);
    await expect(upload).toBeEnabled();

    expireNext = true;
    await upload.click();
    await filename.fill('Reconnected manuscript.pdf');
    await send.click();
    await expect(page.getByTestId('readpaper-config')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByTestId('readpaper-save').click();
    await expect.poll(() => uploads).toEqual([
      'Draft for review.pdf', 'Final manuscript.PDF',
      'Reconnected manuscript.pdf', 'Reconnected manuscript.pdf',
    ]);
    await expect(upload).toBeEnabled();
  } finally { await cleanup(request, id); }
});
