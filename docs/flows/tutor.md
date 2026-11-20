# Tutor domain

This domain is help from a large language model (LLM). It is not a dictionary gloss. Journal correction is the Journal domain. It uses the same `getProvider` stack.

## Tutor chat

**App domain:** Tutor

The Chat widget sits in `src/app/layout.tsx`. Auth routes with no chrome hide it.

```mermaid
sequenceDiagram
  actor User
  participant Widget as ChatWidget
  participant API as chat.ts
  participant LLM as getProvider
  participant DB as chat_messages

  User->>Widget: Open widget
  Widget->>API: GET /api/chat
  API->>API: cleanExpired
  API->>DB: last 50 rows
  User->>Widget: Send
  Widget->>API: POST /api/chat
  API->>API: reserve llmRequestsPerMonth
  API->>LLM: complete task chat
  LLM-->>API: assistant text
  alt Plan is not free
    API->>DB: INSERT user and assistant
  end
  API-->>Widget: both messages
```

### Key files

| Role | Path | Function |
| --- | --- | --- |
| Widget | `src/components/ChatWidget/index.tsx` | `fetchMessages`, `sendMessage`, `clearChat`, `loadMore` |
| Prompts | `src/components/ChatWidget/constants.ts` | `EXAMPLE_PROMPTS` |
| API | `api/src/routes/chat.ts` | `GET /`, `POST /`, `DELETE /` |
| Provider | `api/src/lib/llm/index.ts` | `getProvider` |

The widget calls `apiFetch` itself. The widget does not use `getChatMessages` or `sendChatMessage` in `data-layer.ts`.

### Branches

- If the send is empty, it stays disabled. API returns 400.
- History is per language.
- Free plan does not persist. Free BYOK does not persist. A refresh shows an empty thread.
- Paid history has a 7-day time to live.
- Context is 19 prior rows plus the new message. The route prepends the system prompt into the first user turn so Anthropic works.
- Chat is not in data takeout.

### Tables

`chat_messages`, `usage_counters`.

### Tests

`e2e/chat.spec.ts`, `e2e/chat-language.spec.ts`.

## Conversation

**App domain:** Tutor

The Conversation tab. The learner talks with an AI partner, by voice or by typing. The partner keeps to the learner's words.

| Role | Path | Function |
| --- | --- | --- |
| Screen | `src/app/conversation/page.tsx` | `ConversationPage` |
| Settings | `src/app/settings/components/ConversationSettings/index.tsx` | `ConversationSettings` |
| Client | `src/lib/conversation.ts` | `requestReply`, `speakReply`, `pickEngine` |
| Speech | `src/lib/stt/use-speech-capture.ts` | `useSpeechCapture` |
| API | `api/src/routes/conversation.ts` | `GET /voices`, `POST /reply`, `POST /speak` |
| Logic | `api/src/lib/conversation.ts` | `buildConversationReply`, `meterFor` |

- The browser keeps the conversation in localStorage per language and sends the last 40 turns with each request. The API puts the last 20 into the prompt, after a system prompt with up to 800 of the learner's words and up to 25 learning words.
- The new-word limit (`newPercent`, 0 to 20, default 3) comes from Settings. `CoverageMeter` from the daily reading measures each reply. A reply more than 5 points over the limit is rewritten once, and the reply with fewer new words is kept. The plan counts the turn as one LLM request.
- `meterFor` caches the meter per user and language for 10 minutes, or until the number of known words changes.
- Speech input uses `startRecognition` over `/api/stt/stream`, for self-hosted installs. The final transcript is sent as the learner's turn. Starting the microphone stops a reply that is playing.
- `POST /speak` reads a reply with a podcast engine: Google Cloud, the local server (`PODCAST_TTS_URL`, for example Chatterbox) or ElevenLabs. The voice is the one the Podcast settings use. Audio goes through the shared TTS cache.

Tests: `api/src/lib/conversation.test.ts`, `api/src/routes/conversation.test.ts`, `src/lib/__tests__/conversation.test.ts`, `e2e/conversation.spec.ts`.

## Cloze Explain

**App domain:** Tutor

After a cloze Check, Explain asks for a prose breakdown of that sentence. Dictation has no Explain.

```mermaid
flowchart TD
  check[User checks a cloze] --> btn[ClozeFeedback Explain]
  btn --> post["POST /api/explain"]
  post --> reserve[reserve llmRequestsPerMonth]
  reserve --> complete[provider.complete]
  complete --> md[Markdown explanation]
```

| Role | Path | Function |
| --- | --- | --- |
| Feedback | `src/app/practice/components/Feedback/index.tsx` | wraps `ClozeFeedback` |
| Button | `src/components/ClozeFeedback/index.tsx` | `handleExplain` |
| API | `api/src/routes/explain.ts` | `POST /` |

The route does not persist the text. Free managed allowance is 0. After a success, the button stays disabled.

Tests: `e2e/explain.spec.ts`.
