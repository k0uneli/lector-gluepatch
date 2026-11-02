# Deployment

## Quick Reference

**Container image:** `registry.lector.dev/lector` (or `ghcr.io/heuwels/lector` to opt out of install statistics — identical image)
**UI port:** 3400
**API:** published on 3457. Set `API_URL` to the origin that the browser uses for the API, for example `http://<host>:3457`. The browser calls the Hono API directly. There is no Next.js proxy. The API must be reachable from the browser.

### Deploy

```bash
cd ~/lector
docker compose pull
docker compose up -d
```

### Files on server (`~/lector/`)

- `docker-compose.yml`: copy from `deploy/docker-compose.yml`
- `.env`: copy from `deploy/.env.example`

### Environment Variables

Compose injects environment variables at runtime. The image contains no secrets.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Optional | Enables AI translation for uncommon words |
| `LECTOR_VERSION` | No | Image tag (default: `latest`). A pinned version carries no `v` prefix. Write `3.10.0`, not `v3.10.0`. The git tag keeps the prefix. The image tag drops it. |
| `WEB_PORT` | No | Host port for the UI (default: `3400`) |
| `API_URL` | **Remote** | Browser-facing API origin, for example `http://<host>:3457`. The API is published on host port 3457. The web app calls Hono directly, so the browser must reach it. Default `http://localhost:3457` is correct only on the host. |
| `DATA_PATH` | No | Persistent data directory (default: `./data`) |

Root `docker-compose.yml` is the local path. This `deploy/docker-compose.yml` is the server path. Both pull `registry.lector.dev/lector`, which counts pulls so we have a rough idea how many installs exist. No IP address is stored — see the [privacy policy](https://lector.dev/privacy/).

Both files also carry `ghcr.io/heuwels/lector` as a commented-out line. Swap which line is active to pull the identical image without being counted; nothing else about the install changes.

For cloud mode, Anki, backups, and adoption of self-host data, see the root [README.md](../README.md).

## Cost controls

The app caches synthesized audio. Repeat requests for the same language, voice, rate, and text come from the cache. Default store: `DATA_DIR/tts-cache`.

- `TTS_CACHE=0`: disable the cache
- `TTS_CACHE_MAX_BYTES`: size cap. The cache evicts the oldest entries. Default 1 GiB.
- `TTS_CACHE_S3_BUCKET`: store audio in S3-compatible object storage. Optional companions are `TTS_CACHE_S3_REGION`, `TTS_CACHE_S3_PREFIX` (default `tts-cache/`), and `TTS_CACHE_S3_ENDPOINT`. Credentials come from the usual `AWS_*` and `S3_*` variables. Attach a bucket lifecycle rule for eviction.

When the provider supports a batch API, the word-to-domain classifier uses it at 50% of the synchronous price. Anthropic with an API key is the current batch path. LM Studio, Ollama, and OpenRouter stay on the synchronous path.

- `CLASSIFY_BATCH=0`: force the synchronous path
- `CLASSIFY_BATCH_MAX_REQUESTS`: prompts per batch. Each prompt carries `CLASSIFY_BATCH_SIZE` words. Default 40 × 30.

## Audio import and transcription

Import Audio uploads a podcast or a recording. A worker transcribes it into a timestamped transcript. The result is a reading lesson and a listen-along player. Transcription uses any OpenAI-compatible `POST /v1/audio/transcriptions` backend.

- **Local, default on a Mac.** Run [Speaches](https://speaches.ai) or `faster-whisper-server` on the host, not inside the Lector container. Default `ASR_URL` is `http://localhost:8000`. From a container use `ASR_URL=http://host.docker.internal:8000`.
- **Hosted fallback on Groq.** Set `ASR_URL=https://api.groq.com/openai` plus `ASR_API_KEY` plus `ASR_MAX_BYTES=104857600`.

`ASR_MODEL` defaults to `whisper-large-v3`. The language hint is always sent. Enable the worker with `TRANSCRIBE_WORKER=1`. Audio files live under `DATA_DIR/audio/`. They are not part of the JSON export. The transcript text is part of the export.

`ffmpeg` is optional. It supplies the duration estimate at upload time. It also makes the file that goes to the ASR server smaller. Lector sends only the first audio track, as mono 16 kHz Opus. An 80-minute video is approximately 18 MB instead of hundreds of MB. `ASR_MAX_BYTES` applies to this smaller file. Without `ffmpeg`, Lector sends the original file.

On billed cloud plans, two limits apply. Self-host ignores them.

- `audioTranscriptionMinutesPerMonth`: minutes reserved at upload from the probed duration. Cloud is 300 per month. Plus is 900. Free is 0.
- `maxAudioStorageBytes`: total audio on disk. Cloud is 2 GiB. Plus is 10 GiB.

Both are tunable through `LECTOR_PLAN_LIMITS`.

## Podcast episodes

The Podcast tab makes a slow-reading episode from a chapter. A worker writes the notes for each paragraph with the AI provider, speaks them with a voice engine, and adds them to an audio lesson. Enable the worker with `PODCAST_WORKER=1`. The worker needs `ffmpeg`, which the image contains. `PODCAST_INTERVAL_MS` sets how often it looks for work. The default is 2000.

`ANTHROPIC_PODCAST_MODEL` sets the model for the script. The default is `ANTHROPIC_MODEL`. One chapter of about 30 paragraphs costs about $0.50 on Claude Sonnet.

Choose one or more voice engines:

| Engine | Variables | Notes |
|--------|-----------|-------|
| Google Cloud | `GOOGLE_CLOUD_API_KEY` | The read-aloud key. Episodes use a Chirp 3 HD voice when the language has one, and the standard voice when it does not. The first million characters each month are free. After that, one chapter costs about $2 to $4. |
| Local server | `PODCAST_TTS_URL`, `PODCAST_TTS_VOICE`, `PODCAST_TTS_ENGLISH_VOICE`, optional `PODCAST_TTS_MODEL` and `PODCAST_TTS_API_KEY` | Any OpenAI-compatible `POST /v1/audio/speech` server. Self-host only. |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, optional `ELEVENLABS_MODEL` | Self-host only. The default model is `eleven_multilingual_v2`. A `flash` or `turbo` model costs half as much. One chapter costs about $5 to $10 at API prices. |

For a local server on a GPU, [chatterbox-tts-api](https://chatterboxtts.com) serves Chatterbox Multilingual. It fits a 12 GB card. It takes the language from the voice, not from the request. Upload one voice sample for each book language and one for English, then put their names in `PODCAST_TTS_VOICE` and `PODCAST_TTS_ENGLISH_VOICE`. In a voice name, `{lang}` becomes the language code of the book, or `en` for English. With voices named `narrator-ru`, `narrator-el` and `narrator-en`, set both variables to `narrator-{lang}`. The same sample can serve every language. It speaks Russian and Greek. Its Chinese voice is turned off at the time of writing. Run the server on the GPU host, not inside the Lector container.

Each episode is an audio lesson in a "<book> · Podcast" collection. The audio counts toward `maxAudioStorageBytes`. Google characters count toward `ttsCharsPerMonth`, and each paragraph counts as one AI request.

On a self-hosted install, each book also has a private RSS feed at `/api/podcasts/feed/<token>/<show>`. The phone must reach the API origin. Anyone with the URL can listen, so keep it private. Reset the feed in the Podcast tab to stop the old URLs.

## Voice cloze

Voice mode in cloze practice turns speech into text while the learner speaks. It is for self-hosted installs. Cloud does not serve it.

The browser streams microphone audio to `GET /api/stt/stream`, a WebSocket on the API. A reverse proxy in front of the API must pass WebSocket upgrades. The microphone needs a secure page: HTTPS or `localhost`.

Settings → Voice Recognition selects the speech model:

- **Audio import model.** This is the default. It uses the same `ASR_URL`, `ASR_MODEL`, and `ASR_API_KEY` as audio transcription. A Whisper server gives one answer for each request. Lector sends the clip again approximately every 0.4 seconds, so the words appear in steps.
- **Custom endpoint.** Set a base URL, a protocol, a model name, and an optional API key. The API key goes to the server as a Bearer token.
  - **Realtime** uses the vLLM realtime protocol at `/v1/realtime`. The model sends each word when it hears it. Use it with a streaming model, for example [Voxtral Mini 4B Realtime](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602) on vLLM.
  - **HTTP** uses an OpenAI-compatible `POST /v1/audio/transcriptions`, for example a second Whisper server.

The HTTP protocol sends the language hint. The realtime protocol does not, so the model must detect the language.
