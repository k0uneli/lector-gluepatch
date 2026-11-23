import { test, expect, Page, Route, WebSocket } from '@playwright/test';
import { apiUrl } from './api';
import {
  clearRecognizer,
  FAKE_MICROPHONE,
  startRecognizerStub,
  sttUnreachable,
  useRecognizer,
} from './stt-helpers';

/**
 * The Conversation tab. /api/conversation/* is served by a stateful mock,
 * because the e2e API has no language model or voice engine; the server side
 * is covered by api/src/routes/conversation.test.ts. Speech input runs
 * through the real /api/stt/stream with a stub recognizer.
 *
 * Covers:
 *   - Happy path: nav link, a topic, the opening reply, a typed turn, English
 *   - Words in both kinds of bubble open the definition drawer
 *   - Two spoken turns in a row, each uploaded with its recording; a reply's
 *     audio that arrives after the microphone started never plays
 *   - Press-to-stop mode and the two-minute stream
 *   - Saved conversations: list, reopen, back, delete
 *   - The stitched recording: build, update when stale, delete
 *   - A failed reply can be retried; a browser conversation is imported
 *   - The settings panel stores its choices
 */

test.use(FAKE_MICROPHONE);

interface Msg {
  idx: number;
  role: 'user' | 'assistant';
  text: string;
  translation: string | null;
  newPercent: number | null;
  newWords: string[];
  hasAudio: boolean;
  correction: Correction | null;
  createdAt: string;
}

interface Correction {
  corrected: string;
  corrections: Array<{ original: string; corrected: string; explanation: string; type: string }>;
  explanation: string;
}

/** 'eet' marks a turn with a mistake; anything else is right. */
function correctionFor(text: string): Correction {
  return text.includes(' eet ')
    ? {
        corrected: text.replace(' eet ', ' geëet ').replace('geëet brood', 'brood geëet'),
        corrections: [
          {
            original: 'eet brood',
            corrected: 'brood geëet',
            explanation: 'The past participle goes to the end.',
            type: 'word_order',
          },
        ],
        explanation:
          'In the perfect tense, het takes the past participle geëet at the end of the clause.',
      }
    : { corrected: text, corrections: [], explanation: '' };
}

interface StoredChat {
  chat: {
    id: string;
    topic: string;
    preview: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
    recording: { durationMs: number; messages: number } | null;
  };
  language: string;
  messages: Msg[];
}

const REPLIES = [
  { text: 'Hallo! Hoe gaan dit?', translation: 'Hello! How are you?', newPercent: 0, newWords: [] },
  {
    text: 'Lekker! Wat eet jy vandag?',
    translation: 'Nice! What are you eating today?',
    newPercent: 20,
    newWords: ['lekker'],
  },
  { text: 'Baie goed.', translation: 'Very good.', newPercent: 0, newWords: [] },
];

/** A short silent WAV, so the page has something it can play. */
function silentWav(): Buffer {
  const samples = 800;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

interface MockOptions {
  configured?: boolean;
  failNextReply?: boolean;
  speakDelayMs?: number;
  chats?: StoredChat[];
}

async function mockConversation(page: Page, options: MockOptions = {}) {
  const chats = new Map<string, StoredChat>((options.chats ?? []).map((c) => [c.chat.id, c]));
  const seen = {
    creates: [] as Array<Record<string, unknown>>,
    turns: [] as Array<{ text: string; hasAudio: boolean; newPercent: string; correct?: boolean }>,
    checks: [] as number[],
    speaks: [] as Array<Record<string, unknown>>,
    imports: [] as Array<Record<string, unknown>>,
    recordings: 0,
  };
  let failNext = options.failNextReply ?? false;
  let replyCount = 0;
  let nextId = 1;

  const reply = (chat: StoredChat): Msg | null => {
    if (failNext) {
      failNext = false;
      return null;
    }
    const r = REPLIES[Math.min(replyCount++, REPLIES.length - 1)];
    return add(chat, {
      role: 'assistant',
      text: r.text,
      translation: r.translation,
      newPercent: r.newPercent,
      newWords: r.newWords,
      hasAudio: false,
    });
  };
  const add = (chat: StoredChat, m: Omit<Msg, 'idx' | 'createdAt' | 'correction'>): Msg => {
    const msg = {
      ...m,
      correction: null,
      idx: chat.messages.length,
      createdAt: new Date().toISOString(),
    };
    chat.messages.push(msg);
    chat.chat.messageCount = chat.messages.length;
    chat.chat.preview = chat.messages[0].text;
    chat.chat.updatedAt = new Date().toISOString();
    return msg;
  };
  const newChat = (topic: string): StoredChat => {
    const now = new Date().toISOString();
    const id = `chat-${nextId++}`;
    const chat: StoredChat = {
      chat: {
        id,
        topic,
        preview: '',
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        recording: null,
      },
      language: 'af',
      messages: [],
    };
    chats.set(id, chat);
    return chat;
  };
  const failure = (route: Route) =>
    route.fulfill({ status: 502, json: { error: 'Could not get a reply.' } });

  await page.route('**/api/conversation/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/conversation/, '');
    const method = request.method();

    if (path === '/voices') {
      const configured = options.configured ?? true;
      await route.fulfill({
        json: {
          engines: {
            google: configured ? { configured: true } : { configured: false, reason: 'No key' },
            local: { configured: false, reason: 'Set PODCAST_TTS_URL on the server' },
            elevenlabs: { configured: false, reason: 'Set ELEVENLABS_API_KEY on the server' },
          },
          defaultEngine: configured ? 'google' : null,
        },
      });
      return;
    }
    if (path === '/speak') {
      seen.speaks.push(JSON.parse(request.postData() ?? '{}'));
      if (options.speakDelayMs) await new Promise((r) => setTimeout(r, options.speakDelayMs));
      await route.fulfill({ body: silentWav(), contentType: 'audio/wav' });
      return;
    }
    if (path === '/chats' && method === 'GET') {
      const list = [...chats.values()]
        .map((c) => c.chat)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      await route.fulfill({ json: { chats: list } });
      return;
    }
    if (path === '/chats' && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      seen.creates.push(body);
      const chat = newChat(body.topic ?? '');
      if (!reply(chat)) {
        chats.delete(chat.chat.id);
        await failure(route);
        return;
      }
      await route.fulfill({ status: 201, json: chat });
      return;
    }
    if (path === '/chats/import') {
      const body = JSON.parse(request.postData() ?? '{}');
      seen.imports.push(body);
      const chat = newChat(body.topic ?? '');
      for (const m of body.messages) {
        add(chat, {
          role: m.role,
          text: m.text,
          translation: m.translation ?? null,
          newPercent: m.newPercent ?? null,
          newWords: m.newWords ?? [],
          hasAudio: false,
        });
      }
      await route.fulfill({ status: 201, json: chat });
      return;
    }
    const match = path.match(/^\/chats\/([^/]+)(\/.*)?$/);
    const chat = match ? chats.get(match[1]) : undefined;
    const rest = match?.[2] ?? '';
    if (!chat) {
      await route.fulfill({ status: 404, json: { error: 'Conversation not found' } });
      return;
    }
    if (rest === '' && method === 'GET') {
      await route.fulfill({ json: chat });
    } else if (rest === '' && method === 'DELETE') {
      chats.delete(chat.chat.id);
      await route.fulfill({ json: { success: true } });
    } else if (rest === '/turns') {
      const raw = request.postDataBuffer()?.toString('latin1') ?? '';
      const field = (name: string) =>
        raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1] ?? '';
      const text = Buffer.from(field('text'), 'latin1').toString('utf8');
      const hasAudio = raw.includes('name="audio"');
      const correct = field('correct') === '1';
      seen.turns.push({
        text,
        hasAudio,
        newPercent: field('newPercent'),
        ...(correct ? { correct } : {}),
      });
      const user = add(chat, {
        role: 'user',
        text,
        translation: null,
        newPercent: null,
        newWords: [],
        hasAudio,
      });
      if (correct) user.correction = correctionFor(text);
      const answer = reply(chat);
      if (!answer) await failure(route);
      else await route.fulfill({ json: { messages: [user, answer] } });
    } else if (/^\/messages\/\d+\/correction$/.test(rest)) {
      const idx = Number(rest.split('/')[2]);
      seen.checks.push(idx);
      const message = chat.messages[idx];
      message.correction = correctionFor(message.text);
      await route.fulfill({ json: { message } });
    } else if (rest === '/reply') {
      const answer = reply(chat);
      if (!answer) await failure(route);
      else await route.fulfill({ json: { messages: [answer] } });
    } else if (rest === '/recording' && method === 'POST') {
      seen.recordings++;
      chat.chat.recording = { durationMs: 4200, messages: chat.messages.length };
      await route.fulfill({ json: { recording: chat.chat.recording } });
    } else if (rest === '/recording' && method === 'DELETE') {
      chat.chat.recording = null;
      await route.fulfill({ json: { success: true } });
    } else {
      await route.fulfill({ body: silentWav(), contentType: 'audio/wav' });
    }
  });
  return { seen, chats };
}

async function mockLookup(page: Page) {
  const looked: string[] = [];
  await page.route('**/api/dictionary/lookup**', async (route) => {
    const word = new URL(route.request().url()).searchParams.get('word') ?? '';
    looked.push(word);
    await route.fulfill({
      json: { entry: { word, senses: [{ partOfSpeech: 'noun', gloss: `meaning of ${word}` }] } },
    });
  });
  await page.route('**/api/dictionary/paradigm**', (route) =>
    route.fulfill({ json: { paradigm: null } }),
  );
  return looked;
}

async function startConversation(page: Page, topic = '') {
  await page.goto('/conversation');
  await expect(page.getByTestId('conversation-intro')).toBeVisible();
  if (topic) await page.getByTestId('conversation-topic').fill(topic);
  await page.getByTestId('conversation-start').click();
  await expect(page.getByTestId('conversation-reply').first()).toHaveText(REPLIES[0].text);
}

test.describe('Conversation', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('happy path: open from the nav, start on a topic, reply by typing', async ({ page }) => {
    const { seen } = await mockConversation(page, { configured: false });
    await page.goto('/practice');
    await page.locator('aside').getByRole('link', { name: 'Conversation' }).click();
    await expect(page).toHaveURL(/\/conversation$/);
    await expect(page.getByTestId('conversation-intro')).toContainText('up to 3% new words');

    await page.getByTestId('conversation-topic').fill('food');
    await page.getByTestId('conversation-start').click();
    await expect(page.getByTestId('conversation-reply').first()).toHaveText(REPLIES[0].text);
    await expect(page).toHaveURL(/\/conversation\?c=chat-1$/);
    expect(seen.creates).toEqual([{ topic: 'food', newPercent: 3 }]);
    await expect(page.getByTestId('conversation-topic-label')).toContainText('Topic: food');

    await expect(page.getByTestId('conversation-send')).toBeDisabled();
    await page.getByTestId('conversation-input').fill('Goed dankie');
    await page.getByTestId('conversation-input').press('Enter');
    await expect(page.getByTestId('conversation-user-text')).toHaveText('Goed dankie');
    await expect(page.getByTestId('conversation-reply').nth(1)).toHaveText(REPLIES[1].text);
    expect(seen.turns).toEqual([{ text: 'Goed dankie', hasAudio: false, newPercent: '3' }]);

    const second = page.getByTestId('conversation-partner').nth(1);
    await expect(second.getByTestId('conversation-new-percent')).toHaveText('20% new');
    await expect(second.getByTestId('conversation-new-percent')).toHaveAttribute(
      'title',
      'New: lekker',
    );
    await second.getByTestId('conversation-toggle-translation').click();
    await expect(second.getByTestId('conversation-translation')).toHaveText(
      'Nice! What are you eating today?',
    );
    await expect(page.getByTestId('conversation-play-mine')).toHaveCount(0);
    expect(seen.speaks).toEqual([]);
  });

  test('words in both bubbles open the definition drawer', async ({ page }) => {
    await mockConversation(page, { configured: false });
    const looked = await mockLookup(page);
    await startConversation(page);
    await page.getByTestId('conversation-input').fill('Goed dankie');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);

    const drawer = page.getByTestId('translation-drawer');
    await page
      .getByTestId('conversation-reply')
      .first()
      .getByRole('button', { name: 'Look up Hoe' })
      .click();
    await expect(drawer).toContainText('meaning of Hoe');
    await expect(page.getByTestId('conversation-reply').first()).toHaveText(REPLIES[0].text);

    await page
      .getByTestId('conversation-user-text')
      .getByRole('button', { name: 'Look up dankie' })
      .click();
    await expect(drawer).toContainText('meaning of dankie');
    expect(looked).toEqual(['Hoe', 'dankie']);
  });

  test('two spoken turns in a row are each sent with a recording', async ({ page }) => {
    test.skip(sttUnreachable, 'the containerised API cannot reach the host stub recognizer');
    const stub = await startRecognizerStub();
    try {
      await useRecognizer(page, stub.url);
      const { seen } = await mockConversation(page, { speakDelayMs: 2_000 });
      const sockets: string[] = [];
      page.on('websocket', (ws: WebSocket) => sockets.push(ws.url()));
      await startConversation(page);

      for (const [i, said] of ['Goed dankie', 'Ek eet brood'].entries()) {
        stub.say([said]);
        await expect(page.getByTestId('conversation-mic')).toBeEnabled();
        await page.getByTestId('conversation-mic').click();
        await expect(page.getByTestId('conversation-input')).toHaveValue(said, { timeout: 10000 });
        await page.getByRole('button', { name: 'Stop listening' }).click();
        await expect(page.getByTestId('conversation-user-text').nth(i)).toHaveText(said, {
          timeout: 10000,
        });
        await expect(page.getByTestId('conversation-reply')).toHaveCount(i + 2);
      }
      expect(seen.turns).toEqual([
        { text: 'Goed dankie', hasAudio: true, newPercent: '3' },
        { text: 'Ek eet brood', hasAudio: true, newPercent: '3' },
      ]);
      const speechSockets = sockets.filter((url) => url.includes('/api/stt/stream'));
      expect(speechSockets).toHaveLength(2);
      expect(speechSockets.every((url) => url.includes('maxSeconds=120'))).toBe(true);
      await expect(page.getByTestId('conversation-play-mine')).toHaveCount(2);
    } finally {
      await clearRecognizer(page);
      await stub.close();
    }
  });

  test('a reply still loading never plays over the microphone', async ({ page }) => {
    test.skip(sttUnreachable, 'the containerised API cannot reach the host stub recognizer');
    const stub = await startRecognizerStub();
    try {
      await useRecognizer(page, stub.url);
      const { seen } = await mockConversation(page, { speakDelayMs: 2_500 });
      await startConversation(page);
      await expect.poll(() => seen.speaks.length).toBe(1);

      stub.say(['Goed']);
      await page.getByTestId('conversation-mic').click();
      await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
      await page.waitForTimeout(3_000);
      await expect(page.getByTestId('conversation-play').first()).toHaveText('Play');
      const paused = await page.evaluate(() =>
        [...document.querySelectorAll('audio')].every((a) => a.paused),
      );
      expect(paused).toBe(true);
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect(page.getByTestId('conversation-user-text')).toHaveText('Goed', {
        timeout: 10000,
      });
    } finally {
      await clearRecognizer(page);
      await stub.close();
    }
  });

  test('press-to-stop mode keeps listening until the stop button', async ({ page }) => {
    test.skip(sttUnreachable, 'the containerised API cannot reach the host stub recognizer');
    const stub = await startRecognizerStub();
    try {
      await useRecognizer(page, stub.url);
      await page.addInitScript(() =>
        localStorage.setItem('lector-conversation-stop-mode', 'manual'),
      );
      await mockConversation(page, { configured: false });
      await startConversation(page);
      stub.say(['Goed dankie']);
      await page.getByTestId('conversation-mic').click();
      await expect(page.getByTestId('conversation-input')).toHaveAttribute(
        'placeholder',
        'Listening… press stop when you finish',
      );
      await page.waitForTimeout(4_000);
      await expect(page.getByRole('button', { name: 'Stop listening' })).toBeVisible();
      await page.getByRole('button', { name: 'Stop listening' }).click();
      await expect(page.getByTestId('conversation-user-text')).toHaveText('Goed dankie', {
        timeout: 10000,
      });
    } finally {
      await clearRecognizer(page);
      await stub.close();
    }
  });

  test('saved conversations can be reopened and deleted', async ({ page }) => {
    await mockConversation(page, { configured: false });
    await startConversation(page, 'weather');
    await page.getByTestId('conversation-input').fill('Goed');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);

    await page.getByTestId('conversation-back').click();
    await expect(page).toHaveURL(/\/conversation$/);
    const item = page.getByTestId('conversation-history-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('weather');
    await expect(item).toContainText('3 messages');

    await page.getByTestId('conversation-history-open').click();
    await expect(page).toHaveURL(/\?c=chat-1$/);
    await expect(page.getByTestId('conversation-user-text')).toHaveText('Goed');
    await page.goBack();
    await expect(page.getByTestId('conversation-intro')).toBeVisible();

    await page.getByTestId('conversation-history-delete').click();
    await page.getByTestId('conversation-history-confirm-delete').click();
    await expect(page.getByTestId('conversation-history-item')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('conversation-history')).toHaveCount(0);
  });

  test('the whole conversation can be stitched, updated and deleted', async ({ page }) => {
    const { seen } = await mockConversation(page);
    await page.addInitScript(() => localStorage.setItem('lector-conversation-autoplay', 'false'));
    await startConversation(page);

    await page.getByTestId('conversation-recording-build').click();
    await expect(page.getByTestId('conversation-recording-audio')).toBeVisible();
    await expect(page.getByTestId('conversation-recording')).toContainText('4 s');
    expect(seen.recordings).toBe(1);

    await page.getByTestId('conversation-input').fill('Goed');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
    await expect(page.getByTestId('conversation-recording')).toContainText(
      'covers 1 of 3 messages',
    );
    await page.getByTestId('conversation-recording-update').click();
    await expect(page.getByTestId('conversation-recording-update')).toHaveCount(0);
    expect(seen.recordings).toBe(2);

    await page.getByTestId('conversation-recording-delete').click();
    await page.getByTestId('conversation-recording-confirm-delete').click();
    await expect(page.getByTestId('conversation-recording')).toHaveCount(0);
    await expect(page.getByTestId('conversation-recording-build')).toBeVisible();
  });

  test('without a voice engine the recording cannot be built', async ({ page }) => {
    await mockConversation(page, { configured: false });
    await startConversation(page);
    await expect(page.getByTestId('conversation-recording-build')).toBeDisabled();
  });

  test('a failed reply can be retried, and survives a reload', async ({ page }) => {
    const mock = await mockConversation(page, { configured: false });
    await startConversation(page);
    await page.unroute('**/api/conversation/**');
    await mockConversation(page, {
      configured: false,
      failNextReply: true,
      chats: [...mock.chats.values()],
    });

    await page.getByTestId('conversation-input').fill('Goed');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-error')).toHaveText('Could not get a reply.');
    await expect(page.getByTestId('conversation-user-text')).toHaveText('Goed');
    await expect(page.getByTestId('conversation-send')).toBeDisabled();
    await page.getByTestId('conversation-retry').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
    await expect(page.getByTestId('conversation-error')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
  });

  test('a conversation kept in this browser is saved to the server', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        'lector-conversation:af',
        JSON.stringify({ topic: 'old', messages: [{ role: 'assistant', text: 'Hallo daar' }] }),
      );
    });
    const { seen } = await mockConversation(page, { configured: false });
    await page.goto('/conversation');
    await expect(page.getByTestId('conversation-history-item')).toContainText('old');
    expect(seen.imports).toHaveLength(1);
    expect(await page.evaluate(() => localStorage.getItem('lector-conversation:af'))).toBeNull();
  });

  test('corrections mark mistakes in red and explain them', async ({ page }) => {
    const { seen } = await mockConversation(page, { configured: false });
    await startConversation(page);
    const toggle = page.getByTestId('conversation-corrections');
    await expect(toggle).toHaveText('Corrections off');
    await toggle.click();
    await expect(toggle).toHaveText('Corrections on');

    await page.getByTestId('conversation-input').fill('Ek het eet brood gister');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
    expect(seen.turns[0]).toMatchObject({ text: 'Ek het eet brood gister', correct: true });

    const bubble = page.getByTestId('conversation-correction');
    await expect(bubble.getByTestId('conversation-correction-removed')).toHaveText('eet');
    await expect(bubble.getByTestId('conversation-correction-added')).toHaveText('geëet');
    await expect(page.getByTestId('conversation-user-text')).toHaveText('Ek het eet brood gister');
    await expect(bubble.getByTestId('conversation-correction-details')).toHaveCount(0);
    await bubble.getByTestId('conversation-correction-toggle').click();
    await expect(bubble.getByTestId('conversation-correction-details')).toContainText(
      'The past participle goes to the end.',
    );
    await expect(bubble.getByTestId('conversation-correction-details')).toContainText(
      'takes the past participle geëet',
    );

    await page.getByTestId('conversation-input').fill('Ek is honger');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-correct')).toHaveText('Looks right');

    await page.reload();
    await expect(page.getByTestId('conversation-corrections')).toHaveText('Corrections on');
    await expect(page.getByTestId('conversation-correction-removed')).toHaveText('eet');
  });

  test('an earlier turn can be checked when corrections are on', async ({ page }) => {
    const { seen } = await mockConversation(page, { configured: false });
    await startConversation(page);
    await page.getByTestId('conversation-input').fill('Ek het eet brood');
    await page.getByTestId('conversation-send').click();
    await expect(page.getByTestId('conversation-reply')).toHaveCount(2);
    expect(seen.turns[0].correct).toBeUndefined();
    await expect(page.getByTestId('conversation-check')).toHaveCount(0);
    await expect(page.getByTestId('conversation-correction')).toHaveCount(0);

    await page.getByTestId('conversation-corrections').click();
    await page.getByTestId('conversation-check').click();
    await expect(page.getByTestId('conversation-correction-added')).toHaveText('geëet');
    await expect(page.getByTestId('conversation-check')).toHaveCount(0);
    expect(seen.checks).toEqual([1]);
  });

  test('the definition card adds a word to Anki from its header', async ({ page }) => {
    await mockConversation(page, { configured: false });
    await mockLookup(page);
    await page.request.delete(apiUrl('/api/settings/ankiConnectUrl')).catch(() => {});
    await page.request.delete(apiUrl('/api/settings/ankiTransport')).catch(() => {});
    const calls: Array<{
      action: string;
      params?: { note?: { fields?: Record<string, string> } };
    }> = [];
    const anki = async (route: Route) => {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': 'application/json',
      };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 200, headers });
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      const results: Record<string, unknown> = { version: 6, createDeck: 1, addNote: 1234567890 };
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ result: results[body.action] ?? null, error: null }),
      });
    };
    await page.route('**://localhost:8765/**', anki);
    await page.route('http://localhost:8765/', anki);
    try {
      await startConversation(page);
      await page
        .getByTestId('conversation-reply')
        .first()
        .getByRole('button', { name: 'Look up Hoe' })
        .click();
      const drawer = page.getByTestId('translation-drawer');
      await expect(drawer).toContainText('meaning of Hoe');
      const anki = drawer.getByTestId('add-to-anki-btn');
      await expect(anki).toHaveCount(1);
      await expect(anki).toHaveText('+ Anki');
      const header = drawer
        .locator('div', { has: page.getByRole('button', { name: 'Close' }) })
        .first();
      await expect(header.getByTestId('add-to-anki-btn')).toBeVisible();
      await anki.click();
      await expect(anki).toHaveText('✓ Anki');
      const note = calls.find((c) => c.action === 'addNote');
      expect(note?.params?.note?.fields).toBeTruthy();
    } finally {
      const vocab = (await (await page.request.get(apiUrl('/api/vocab'))).json()) as Array<{
        id: string;
        text: string;
      }>;
      for (const v of vocab.filter((v) => v.text === 'hoe')) {
        await page.request.delete(apiUrl(`/api/vocab/${v.id}`));
      }
    }
  });

  test('the settings panel stores its choices', async ({ page }) => {
    await mockConversation(page);
    await page.goto('/settings');
    const panel = page.getByTestId('conversation-settings');
    await expect(panel.getByTestId('conversation-new-percent-value')).toHaveText('up to 3%');
    await panel.getByTestId('conversation-new-percent-slider').getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByTestId('conversation-new-percent-value')).toHaveText('up to 5%');
    await expect(panel.getByTestId('conversation-voice-google')).toBeChecked();
    await expect(panel.getByTestId('conversation-voice-local')).toBeDisabled();
    await panel.getByTestId('conversation-autoplay-setting').uncheck();
    await expect(panel.getByTestId('conversation-pause-value')).toHaveText('2.5 s');
    await panel.getByTestId('conversation-pause-slider').getByRole('slider').focus();
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByTestId('conversation-pause-value')).toHaveText('3 s');
    await panel.getByTestId('conversation-stop-manual').click();
    await expect(panel.getByTestId('conversation-pause-slider')).toHaveCount(0);
    expect(
      await page.evaluate(() => [
        localStorage.getItem('lector-conversation-new-percent'),
        localStorage.getItem('lector-conversation-autoplay'),
        localStorage.getItem('lector-conversation-stop-mode'),
        localStorage.getItem('lector-conversation-pause-seconds'),
      ]),
    ).toEqual(['5', 'false', 'manual', '3']);

    const { seen } = await mockConversation(page);
    await page.goto('/conversation');
    await expect(page.getByTestId('conversation-intro')).toContainText('up to 5% new words');
    await page.getByTestId('conversation-start').click();
    await expect(page.getByTestId('conversation-reply').first()).toBeVisible();
    expect(seen.creates.at(-1)?.newPercent).toBe(5);
    expect(seen.speaks).toEqual([]);
  });

  test('the mobile bottom bar shows the short label', async ({ page }) => {
    await mockConversation(page, { configured: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/conversation');
    await expect(
      page.locator('nav.fixed').getByRole('link', { name: 'Talk', exact: true }),
    ).toBeVisible();
  });
});
