import { test, expect, Page } from '@playwright/test';
import { apiUrl } from './api';

/**
 * A form-of dictionary entry ("first-person singular … of слы́шать") shows the
 * meaning of the lemma it names, and the lemma opens on click.
 *
 * The lookup is stubbed so the spec needs no dictionary file; the
 * lemmaEntries shape it returns is covered against SQLite in
 * api/src/lib/dictionary-db.lemma.test.ts.
 */

const COLLECTION_TITLE = 'Form-of Lemma Test';
const FORM_GLOSS = 'plural of vrug';

const ENTRIES: Record<string, unknown> = {
  vrugte: {
    word: 'vrugte',
    source: 'dict',
    senses: [{ partOfSpeech: 'noun', gloss: FORM_GLOSS }],
    lemmaEntries: [
      {
        word: 'vrug',
        senses: [
          { partOfSpeech: 'noun', gloss: 'fruit' },
          { partOfSpeech: 'noun', gloss: 'result, outcome' },
        ],
      },
    ],
  },
  vrug: {
    word: 'vrug',
    source: 'dict',
    senses: [{ partOfSpeech: 'noun', gloss: 'fruit' }],
  },
};

async function cleanup(page: Page) {
  const collections = await (await page.request.get(apiUrl('/api/collections'))).json();
  for (const c of collections) {
    if (c.title === COLLECTION_TITLE) await page.request.delete(apiUrl(`/api/collections/${c.id}`));
  }
  const vocab = (await (await page.request.get(apiUrl('/api/vocab'))).json()) as Array<{
    id: string;
    text: string;
  }>;
  for (const v of vocab) {
    if (v.text === 'vrugte' || v.text === 'vrug') {
      await page.request.delete(apiUrl(`/api/vocab/${v.id}`));
    }
  }
}

async function openLesson(page: Page) {
  const { id: collectionId } = await (
    await page.request.post(apiUrl('/api/collections'), {
      data: { title: COLLECTION_TITLE, language: 'af' },
    })
  ).json();
  await page.request.post(apiUrl(`/api/collections/${collectionId}/lessons`), {
    data: { title: 'Hoofstuk 1', textContent: 'Die vrugte is lekker.' },
  });
  const lessons = await (
    await page.request.get(apiUrl(`/api/collections/${collectionId}/lessons`))
  ).json();
  await page.goto(`/read/${lessons[0].id}`);
  await expect(page.getByText('vrugte')).toBeVisible({ timeout: 10000 });
}

test.describe('Form-of entries show their lemma', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await cleanup(page);
    await page.route('**/api/dictionary/lookup?*', async (route) => {
      const word = new URL(route.request().url()).searchParams.get('word') ?? '';
      await route.fulfill({ json: { entry: ENTRIES[word.toLowerCase()] ?? null } });
    });
  });

  test.afterEach(async ({ page }) => {
    await cleanup(page);
  });

  test('the drawer shows the lemma meaning, and the lemma opens on click', async ({ page }) => {
    await openLesson(page);
    await page.locator('article span.cursor-pointer', { hasText: 'vrugte' }).first().click();

    const drawer = page.getByTestId('translation-drawer');
    await expect(drawer.getByText(FORM_GLOSS.replace(' vrug', ''))).toBeVisible({
      timeout: 5000,
    });
    const lemma = drawer.getByTestId('lemma-entries');
    await expect(lemma.getByText('fruit', { exact: true })).toBeVisible();
    await expect(lemma.getByText('result, outcome')).toBeVisible();

    await lemma.getByTestId('lemma-entry-link').click();
    await expect(drawer.getByRole('heading', { name: 'vrug', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(drawer.getByTestId('lemma-entries')).toHaveCount(0);
  });

  test('saving the form stores the lemma meaning as its translation', async ({ page }) => {
    await openLesson(page);
    await page.locator('article span.cursor-pointer', { hasText: 'vrugte' }).first().click();
    const drawer = page.getByTestId('translation-drawer');
    await expect(drawer.getByTestId('lemma-entries')).toBeVisible({ timeout: 5000 });

    await drawer.getByTestId('word-level-1').click();

    await expect
      .poll(async () => {
        const vocab = (await (await page.request.get(apiUrl('/api/vocab'))).json()) as Array<{
          text: string;
          translation: string;
        }>;
        return vocab.find((v) => v.text === 'vrugte')?.translation;
      })
      .toBe(`fruit; result, outcome — ${FORM_GLOSS}`);
  });
});
