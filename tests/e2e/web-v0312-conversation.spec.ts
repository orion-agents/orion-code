import { expect, test } from './fixtures/test';
import { createSession, submitPrompt, waitForWorkbenchReady, workbenchUi } from './fixtures/ui';

test.use({ trace: 'off', video: 'off', screenshot: 'only-on-failure' });

/**
 * v0.3.12 — real conversation smoke over the real Orion Web host and a real
 * (fixture) model provider: create a session, submit a prompt, and observe the
 * agent turn stream an assistant message into the transcript. Exercises the
 * full chain — Host HTTP, session bootstrap, runtime agent loop, OpenAI-compat
 * provider SSE, event stream and transcript rendering — without mocks at the
 * browser-request layer.
 */
test('WEB33-P0-15 real conversation turn streams an assistant message into the transcript', async ({
  page,
  workspace,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1_600, height: 900 });
  const ui = workbenchUi(page);
  await waitForWorkbenchReady(page, { timeout: 30_000 });
  await expect(ui.composer).toBeEnabled({ timeout: 30_000 });

  await createSession(page);

  const promptText = `v0.3.12 conversation smoke ${workspace.displayName} reply briefly`;
  await submitPrompt(page, promptText, { timeout: 30_000 });

  // The fixture provider answers any prompt with an assistant stream; wait for
  // the first Orion (assistant) article to appear in the transcript.
  const assistant = page.getByRole('article', { name: 'Orion' }).first();
  await expect(assistant).toBeVisible({ timeout: 90_000 });

  // The user echo and at least one assistant article coexist, and the composer
  // returns to an idle, sendable state after the turn.
  await expect(
    page.getByRole('article', { name: '你' }).filter({ hasText: promptText })
  ).toBeVisible();
  await expect(ui.composer).toBeEnabled({ timeout: 60_000 });

  const transcript = ui.transcript;
  const articleCount = await transcript.getByRole('article').count();
  expect(articleCount).toBeGreaterThanOrEqual(2);
});
