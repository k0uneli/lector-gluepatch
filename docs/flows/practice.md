# Practice domain

This domain runs cloze, voice cloze, and dictation with spaced repetition (SRS). Cards live in `clozeSentences`. Mastery 100 also writes the Vocabulary domain.

Intervals in days come from `calculateNextReview`:

| Mastery | Days |
| --- | --- |
| 0 | 0 |
| 25 | 1 |
| 50 | 3 |
| 75 | 7 |
| 100 | 14 |

A correct answer adds 25, cap 100. A miss sets mastery to 0 and re-queues the card in the same round. Retry awards no points. When a mastery 100 card is due, it still appears.

## Practice word

**App domain:** Practice

The user opens `/practice`, picks a collection, then reviews due cards or learns new cards.

### Path

```mermaid
sequenceDiagram
  actor User
  participant Page as PracticePage
  participant Round as useClozeRound
  participant Persist as persistReview
  participant DL as data-layer
  participant API as cloze.ts
  participant DB as clozeSentences

  User->>Page: Open /practice
  Page->>DL: seedSentenceBank
  DL->>API: POST /api/cloze/seed
  API->>DB: INSERT from sentence-bank JSON
  User->>Page: Review Due or Start
  Page->>DL: getClozeSentencesByCollection or getNewSentencesByCollection
  DL->>API: GET /api/cloze/due
  API->>DB: due or new rows
  Page->>Round: presentRound
  User->>Page: Type or pick then Check
  Page->>Page: checkAnswer
  Page->>Round: commitRoundReview
  Round->>Persist: persistReview
  Persist->>DL: updateClozeAfterReview
  DL->>API: POST /api/cloze/:id/review
  API->>DB: masteryLevel, nextReview, counters
  opt Mastery 100
    Persist->>DL: updateWordState known
  end
  Persist->>DL: incrementDailyStat clozePracticed
```

### Key files

| Role | Path | Function |
| --- | --- | --- |
| Page | `src/app/practice/page.tsx` | `startRoundWith`, `handleSubmit`, `handleMcSelect`, `recordAnswer` |
| Round | `src/app/practice/use-cloze-round.ts` | `useClozeRound`, `clozeRoundReducer`, `commitRoundReview` |
| Persist | `src/app/practice/persist-review.ts` | `persistReview` |
| Grade | `src/app/practice/utils.ts` | `checkAnswer`, `normalize`, `calculateNextReview`, `calculatePoints`, `createBlankedSentence`, `buildMultipleChoiceOptions` |
| Feedback | `src/app/practice/components/Feedback/index.tsx` | `Feedback` |
| Client | `src/lib/data-layer.ts` | `seedSentenceBank`, `getClozeSentencesByCollection`, `getNewSentencesByCollection`, `updateClozeAfterReview` |
| API | `api/src/routes/cloze.ts` | `POST /seed`, `GET /due`, `GET /counts`, `POST /:id/review` |
| Bank | `api/src/lib/sentence-bank-*.json` | `loadSentenceBank` |
| Tokens | `api/src/lib/languages.ts` | `resolveClozeTokens` |
| Punct | `src/lib/words.ts` | `splitTrailingPunctuation` |

`GET /due` modes:

- `mode=new`: `reviewCount = 0`
- `mode=review`: `nextReview <= now` and `reviewCount > 0`. This includes mastery 100.
- else: `nextReview <= now`

Blacklisted rows stay out. Order is random.

### Branches

- The Type, MC, or Voice mode lives in `localStorage` key `cloze-practice-mode`.
- Type mode can fall back to MC mode for one card. The next card returns to type.
- If `persistReview` fails, the round does not advance.
- Word-state and daily-stat writes are best effort after a saved review.
- Punctuation after the word sits outside the blank. The grade step strips it. The known-word write also strips it.
- The seed step copies rows from Tatoeba in the JSON bank. The seed step also copies mined rows.
- Live `GET /api/tatoeba` is not on this path.
- The UI collections are:
  - `top500`
  - `top1000`
  - `top2000`
- Collection `mined` is for Onboarding only.

### Tables

`clozeSentences`, `knownWords` at mastery 100, and `dailyStats`.

### Tests

`e2e/practice.spec.ts`, `e2e/mc-fallback.spec.ts`, `e2e/cloze-definitions.spec.ts`. Unit: `src/app/practice/__tests__/use-cloze-round.test.ts`, `persist-review.test.ts`.

## Dictation

**App domain:** Practice

Same SRS persist. The user types the full sentence after TTS.

| Role | Path | Function |
| --- | --- | --- |
| Page | `src/app/practice/page.tsx` | `recordDictation`, `handleSetPracticeFormat` |
| Card | `src/app/practice/components/Dictation/DictationCard.tsx` | `DictationCard` |
| Grade | `src/app/practice/utils.ts` | `diffDictation`, `scoreDictation`, `calculateDictationPoints` |
| Speech | `src/lib/tts.ts` | `speak`, `hasAudio` |

Pass threshold is 0.75. Surrender is always a miss. A pack with `pronunciation.audio: 'none'` hides Dictation.

Tests: `e2e/dictation.spec.ts`.

## Voice cloze

**App domain:** Practice

Selfhost only. The user says the missing word or the whole sentence. The transcript shows each word as it arrives.

```mermaid
sequenceDiagram
  actor User
  participant Card as VoiceAnswer
  participant Rec as startRecognition
  participant API as stt.ts
  participant STT as Speech model

  User->>Card: Click the mic or press Space
  Card->>Rec: startRecognition(language)
  Rec->>API: WebSocket /api/stt/stream
  loop While the user speaks
    Rec->>API: PCM16 16 kHz frames
    API->>STT: realtime append, or the whole clip again
    STT-->>API: delta or transcript
    API-->>Card: transcript so far
    Card->>Card: matchVoiceAnswer
  end
  Card->>Card: Match stops the mic
  Card->>Card: onAnswer, then recordAnswer
```

| Role | Path | Function |
| --- | --- | --- |
| Page | `src/app/practice/page.tsx` | `handleVoiceAnswer`, `handleTypeInstead`, `recordAnswer` |
| Card | `src/app/practice/components/VoiceAnswer/index.tsx` | `VoiceAnswer` |
| Grade | `src/app/practice/utils.ts` | `matchVoiceAnswer` |
| Client | `src/lib/stt/index.ts` | `startRecognition`, `isVoiceInputSupported` |
| Audio | `src/lib/stt/audio.ts` | `Downsampler`, `Endpointer` |
| API | `api/src/routes/stt.ts` | `GET /stream`, `GET /status` |
| Sessions | `api/src/lib/stt.ts` | `resolveSttConfig`, `HttpSttSession`, `RealtimeSttSession` |

### Branches

- Source `asr` uses the `ASR_*` env of audio import. It sends the whole clip to `/v1/audio/transcriptions` again every 400 ms.
- Source `custom` with protocol `realtime` relays to vLLM `/v1/realtime`. Protocol `http` works like `asr`.
- A match on a partial transcript is accepted at once. When the answer word also occurs in another position, the heard word must align with the blank.
- An empty transcript does not use an attempt. The third wrong transcript is a miss. Give up is a miss.
- Type instead switches only this card to typing.
- The endpointer stops the mic after 1.5 s of silence after speech, 8 s with no speech, or 15 s in total. The API keeps at most 30 s of audio.
- Cloud answers `404` on `/api/stt/*`. The Voice mode button does not show.

Tests: `e2e/voice-cloze.spec.ts`. Unit: `src/app/practice/__tests__/voice.test.ts`, `src/lib/stt/audio.test.ts`, `api/src/lib/stt.test.ts`, `api/src/routes/stt.test.ts`.

## Blacklist sentence

**App domain:** Practice

| Role | Path | Function |
| --- | --- | --- |
| Button | `src/app/practice/components/BlacklistSentence/index.tsx` | `handleBlacklist`, `handleUndoBlacklist` |
| Round | `src/app/practice/use-cloze-round.ts` | `blacklistCurrent` |
| Client | `src/lib/data-layer.ts` | `blacklistClozeSentence`, `unblacklistClozeSentence` |
| API | `api/src/routes/cloze.ts` | `PUT /:id` `{ blacklisted }` |

The row stays in the table. Due queries exclude it. Undo does not put the card back in the current round.

## Onboarding cloze

See [Onboarding](onboarding.md). Cards use `source = 'mined'`, `collection = 'mined'`, id `onboarding:{vocabId}`.
