import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { getCurrentUserId } from '../lib/user';
import { resolveLanguage } from '../lib/active-language';
import { config, type LectorMode } from '../lib/config';
import {
  checkSttHealth,
  openSttSession,
  resolveSttConfig,
  type SttServerMessage,
  type SttSession,
  DEFAULT_SESSION_SECONDS,
  MAX_SESSION_SECONDS,
} from '../lib/stt';

/**
 * Selfhost only: the endpoint is a user setting, and cloud must not fetch a
 * caller-controlled URL or spend the deployment's ASR allowance unmetered.
 */
export function makeSttRoutes(mode: LectorMode = config.mode): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (mode !== 'selfhost') return c.json({ error: 'Not found' }, 404);
    return next();
  });

  // GET /api/stt/status
  app.get('/status', async (c) => {
    const stt = resolveSttConfig(getCurrentUserId(c));
    const health = await checkSttHealth(stt);
    return c.json({
      source: stt.source,
      protocol: stt.protocol,
      model: stt.model,
      endpoint: stt.baseUrl,
      ...health,
    });
  });

  // GET /api/stt/stream — WebSocket. Binary frames in: PCM16 LE mono 16 kHz.
  // Text frame in: {"type":"stop"}. Text frames out: SttServerMessage.
  app.get(
    '/stream',
    upgradeWebSocket((c) => {
      const userId = getCurrentUserId(c);
      const language = resolveLanguage(c.req.query('language'), userId);
      const stt = resolveSttConfig(userId);
      const requested = Number(c.req.query('maxSeconds'));
      const maxSeconds =
        Number.isInteger(requested) && requested > 0
          ? Math.min(requested, MAX_SESSION_SECONDS)
          : DEFAULT_SESSION_SECONDS;
      let session: SttSession | null = null;
      let open = true;

      return {
        onOpen(_event, ws) {
          const emit = (message: SttServerMessage) => {
            if (open) ws.send(JSON.stringify(message));
          };
          session = openSttSession(
            stt,
            language,
            emit,
            () => {
              if (open) ws.close();
            },
            maxSeconds,
          );
        },
        onMessage(event) {
          if (typeof event.data === 'string') {
            try {
              if (JSON.parse(event.data)?.type === 'stop') session?.finish();
            } catch {
              // Not JSON: nothing to act on.
            }
            return;
          }
          if (event.data instanceof ArrayBuffer) session?.pushAudio(new Uint8Array(event.data));
        },
        onClose() {
          open = false;
          session?.abort();
        },
      };
    }),
  );

  return app;
}

export default makeSttRoutes();
