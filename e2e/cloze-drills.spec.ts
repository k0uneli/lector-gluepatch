import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from './api';
import { switchLanguage } from './language-helpers';

// CI has no dictionaries, so the spec seeds real cards (reviews must save) and
// answers the drill requests with the inflection data the API would attach.
const COLLECTION = 'top2000';
const BASE_CARD = {
  translation: '-',
  language: 'ru',
  source: 'tatoeba',
  collection: COLLECTION,
  masteryLevel: 0,
  nextReview: '2020-01-01T00:00:00.000Z',
  reviewCount: 0,
  timesCorrect: 0,
  timesIncorrect: 0,
};
const KNIGA = {
  ...BASE_CARD,
  id: 'e2e-drill-kniga',
  sentence: 'Я читаю книгу.',
  clozeWord: 'книгу.',
  clozeIndex: 2,
  translation: 'I am reading a book.',
};
const CHITALA = {
  ...BASE_CARD,
  id: 'e2e-drill-chitala',
  sentence: 'Она читала весь день.',
  clozeWord: 'читала',
  clozeIndex: 1,
  translation: 'She read all day.',
};
const INFLECTION = {
  [KNIGA.id]: {
    lemma: 'книга',
    aspectPair: null,
    tags: ['accusative', 'singular'],
    description: 'accusative singular',
    stem: 'книг',
    ending: 'у',
    distractors: ['книге', 'книгой', 'книга'],
  },
  [CHITALA.id]: {
    lemma: 'читать',
    aspectPair: ['читать', 'прочитать'],
    tags: ['feminine', 'past', 'singular'],
    description: 'feminine singular past indicative imperfective',
    stem: 'чита',
    ending: 'ла',
    distractors: ['читал', 'читали', 'читало'],
  },
};

async function seedCards(page: Page) {
  for (const card of [KNIGA, CHITALA]) {
    await page.request.delete(apiUrl(`/api/cloze/${card.id}`));
  }
  const res = await page.request.post(apiUrl('/api/cloze'), { data: [KNIGA, CHITALA] });
  expect(res.ok()).toBeTruthy();
}

/** Serve `cards` to every drill request, as the API would with a dictionary. */
async function serveDrillCards(page: Page, cards: Array<typeof KNIGA>) {
  await page.route('**/api/cloze/due?**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.get('drill')) return route.continue();
    await route.fulfill({
      json: cards.map((card) => ({ ...card, inflection: INFLECTION[card.id] })),
    });
  });
}

async function openSetup(page: Page) {
  await page.goto('/practice');
  await expect(page.getByRole('button', { name: 'Start' })).toBeEnabled({ timeout: 30000 });
}

async function chooseDrill(page: Page, label: 'Whole word' | 'Ending' | 'Base form') {
  await page.getByTestId('cloze-drill').click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  await expect(page.getByTestId('cloze-drill')).toHaveText(label);
}

async function startRound(page: Page, mode: 'Type' | 'MC') {
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('button', { name: '10', exact: true }).click();
  await page.getByRole('button', { name: 'Start' }).click();
}

test.describe.serial('Cloze inflection drills', () => {
  test.beforeEach(async ({ page }) => {
    await switchLanguage(page, 'ru', 'Русский');
    await seedCards(page);
  });

  test.afterEach(async ({ page }) => {
    for (const card of [KNIGA, CHITALA]) {
      await page.request.delete(apiUrl(`/api/cloze/${card.id}`));
    }
    await page.request.put(apiUrl('/api/settings/targetLanguage'), { data: { value: 'af' } });
  });

  test('Ending drill: type the case ending after the stem', async ({ page }) => {
    await serveDrillCards(page, [KNIGA]);
    await openSetup(page);
    await chooseDrill(page, 'Ending');
    await startRound(page, 'Type');

    await expect(page.getByText('Fill in the ending')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('cloze-stem')).toHaveText('книг');

    await page.locator('input[placeholder="..."]').fill('у');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Correct!' })).toBeVisible();
    await expect(page.getByTestId('cloze-grammar')).toHaveText('accusative singular of книга');
    const card = await (await page.request.get(apiUrl(`/api/cloze/${KNIGA.id}`))).json();
    expect(card.masteryLevel).toBe(25);
  });

  test('Ending drill: a wrong ending is a miss that shows the whole word', async ({ page }) => {
    await serveDrillCards(page, [KNIGA]);
    await openSetup(page);
    await chooseDrill(page, 'Ending');
    await startRound(page, 'Type');

    await page.locator('input[placeholder="..."]').fill('а');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Incorrect' })).toBeVisible();
    await expect(page.getByText('книга', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('книгу', { exact: true }).first()).toBeVisible();
  });

  test('Ending drill: multiple choice lists the endings', async ({ page }) => {
    await serveDrillCards(page, [KNIGA]);
    await openSetup(page);
    await chooseDrill(page, 'Ending');
    await startRound(page, 'MC');

    await expect(page.getByText('Choose the correct form')).toBeVisible({ timeout: 10000 });
    const options = page.getByTestId('mc-option');
    await expect(options).toHaveCount(4);
    await expect(options.filter({ hasText: '-ой' })).toHaveCount(1);
    await options.filter({ hasText: /-у$/ }).click();

    await expect(page.getByRole('heading', { name: 'Correct!' })).toBeVisible({ timeout: 5000 });
  });

  test('Base form drill: the aspect pair is shown and the form is chosen', async ({ page }) => {
    await serveDrillCards(page, [CHITALA]);
    await openSetup(page);
    await chooseDrill(page, 'Base form');
    await startRound(page, 'MC');

    await expect(page.getByTestId('cloze-base-form')).toHaveText('(читать / прочитать)', {
      timeout: 10000,
    });
    const options = page.getByTestId('mc-option');
    await expect(options).toHaveCount(4);
    await options.filter({ hasText: /^\d?читала$/ }).click();

    await expect(page.getByRole('heading', { name: 'Correct!' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('cloze-grammar')).toHaveText(
      'feminine singular past indicative imperfective of читать',
    );
  });

  test('Base form drill: typing the form', async ({ page }) => {
    await serveDrillCards(page, [CHITALA]);
    await openSetup(page);
    await chooseDrill(page, 'Base form');
    await startRound(page, 'Type');

    await expect(page.getByText('Put the word in the right form')).toBeVisible({
      timeout: 10000,
    });
    await page.locator('input[placeholder="..."]').fill('читала');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Correct!' })).toBeVisible();
  });

  test('the chosen drill survives a reload', async ({ page }) => {
    await openSetup(page);
    await chooseDrill(page, 'Base form');
    await openSetup(page);
    await expect(page.getByTestId('cloze-drill')).toHaveText('Base form');
    await chooseDrill(page, 'Whole word');
  });

  test('a drill with no inflected cards shows the empty state', async ({ page }) => {
    await serveDrillCards(page, []);
    await openSetup(page);
    await chooseDrill(page, 'Ending');
    await startRound(page, 'Type');

    await expect(page.getByText('No New Sentences')).toBeVisible({ timeout: 10000 });
  });
});

test('the drill menu is hidden for a language without inflection drills', async ({ page }) => {
  await page.request.put(apiUrl('/api/settings/targetLanguage'), { data: { value: 'af' } });
  await openSetup(page);
  await expect(page.getByRole('button', { name: 'MC', exact: true })).toBeVisible();
  await expect(page.getByTestId('cloze-drill')).toHaveCount(0);
});
