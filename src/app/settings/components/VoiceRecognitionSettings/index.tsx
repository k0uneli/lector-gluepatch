'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { deleteSetting, getAllSettings, setSetting } from '@/lib/data-layer';
import { getSttStatus, type SttStatus } from '@/lib/stt';

type Source = SttStatus['source'];
type Protocol = SttStatus['protocol'];

const MODEL_PLACEHOLDER: Record<Protocol, string> = {
  realtime: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
  http: 'whisper-large-v3',
};

const inputClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none';

export default function VoiceRecognitionSettings() {
  const [source, setSource] = useState<Source>('asr');
  const [protocol, setProtocol] = useState<Protocol>('realtime');
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [status, setStatus] = useState<SttStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getSttStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      const settings = await getAllSettings().catch(() => ({}) as Record<string, unknown>);
      setSource(settings.sttSource === 'custom' ? 'custom' : 'asr');
      setProtocol(settings.sttProtocol === 'http' ? 'http' : 'realtime');
      if (typeof settings.sttUrl === 'string') setUrl(settings.sttUrl);
      if (typeof settings.sttModel === 'string') setModel(settings.sttModel);
      setHasApiKey(settings.sttApiKey === true);
      await refreshStatus();
    };
    void load();
  }, [refreshStatus]);

  const save = async (write: Promise<unknown>) => {
    try {
      await write;
      await refreshStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save setting');
    }
  };

  const chooseSource = (next: Source) => {
    setSource(next);
    void save(setSetting('sttSource', next));
  };

  const chooseProtocol = (next: Protocol) => {
    setProtocol(next);
    void save(setSetting('sttProtocol', next));
  };

  const saveApiKey = () => {
    const key = newApiKey.trim();
    if (!key) return;
    void save(
      setSetting('sttApiKey', key).then(() => {
        setHasApiKey(true);
        setNewApiKey('');
        setEditingApiKey(false);
      }),
    );
  };

  const clearApiKey = () => {
    void save(
      deleteSetting('sttApiKey').then(() => {
        setHasApiKey(false);
        setEditingApiKey(false);
      }),
    );
  };

  const statusText = checking
    ? 'Checking…'
    : status?.ok
      ? 'Connected'
      : status?.error || 'Not connected';

  return (
    <section className="panel space-y-4 p-6" data-testid="stt-settings">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Voice Recognition</h2>
        <div className="flex items-center gap-2">
          <span
            className={clsx('inline-block h-2 w-2 rounded-full', {
              'bg-yellow-500': checking,
              'bg-primary': !checking && status?.ok,
              'bg-destructive': !checking && !status?.ok,
            })}
          />
          <span className="text-sm text-muted-foreground" data-testid="stt-status">
            {statusText}
          </span>
          <Button variant="link" onClick={() => void refreshStatus()} disabled={checking}>
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Voice cloze turns what you say into text. Choose the speech-to-text model it uses.
      </p>

      <div>
        <label className="mb-2 block text-sm font-medium text-foreground">Model</label>
        <div className="flex gap-2">
          <Button
            onClick={() => chooseSource('asr')}
            variant={source === 'asr' ? 'default' : 'secondary'}
            data-testid="stt-source-asr"
          >
            Audio import model
          </Button>
          <Button
            onClick={() => chooseSource('custom')}
            variant={source === 'custom' ? 'default' : 'secondary'}
            data-testid="stt-source-custom"
          >
            Custom endpoint
          </Button>
        </div>
        {source === 'asr' && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="stt-asr-note">
            Uses the speech-to-text server that transcribes imported audio lessons
            {status?.source === 'asr' && (
              <>
                {' '}
                (<code className="rounded bg-muted px-1">{status.model}</code> at{' '}
                <code className="rounded bg-muted px-1">{status.endpoint}</code>)
              </>
            )}
            . The operator sets it with <code className="rounded bg-muted px-1">ASR_URL</code>. This
            server answers once per request, so words appear in steps of about half a second.
          </p>
        )}
      </div>

      {source === 'custom' && (
        <div className="space-y-4" data-testid="stt-custom">
          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">Protocol</label>
            <select
              value={protocol}
              onChange={(e) => chooseProtocol(e.target.value as Protocol)}
              data-testid="stt-protocol"
              className={inputClass}
            >
              <option value="realtime">Realtime WebSocket (vLLM /v1/realtime)</option>
              <option value="http">HTTP transcriptions (/v1/audio/transcriptions)</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Realtime streams each word as the model hears it. Use it for a streaming model such as
              Voxtral Mini 4B Realtime served by vLLM. HTTP suits Whisper servers.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">Endpoint</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => void save(setSetting('sttUrl', url.trim()))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder="http://localhost:8000"
              data-testid="stt-endpoint"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Base URL of the server. Lector adds the{' '}
              <code className="rounded bg-muted px-1">/v1/…</code> path. The Lector server makes the
              call, so <code className="rounded bg-muted px-1">localhost</code> is the machine that
              runs Lector.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">Model name</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void save(setSetting('sttModel', model.trim()))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder={MODEL_PLACEHOLDER[protocol]}
              data-testid="stt-model"
              className={inputClass}
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-foreground">
              API key (optional)
            </label>
            {hasApiKey && !editingApiKey ? (
              <div className="flex items-center gap-2">
                <span
                  className="inline-flex items-center rounded-md bg-[var(--primary-soft)] px-2 py-1 text-xs font-medium text-primary"
                  data-testid="stt-api-key-status"
                >
                  Configured
                </span>
                <Button size="sm" variant="secondary" onClick={() => setEditingApiKey(true)}>
                  Replace
                </Button>
                <Button size="sm" variant="destructive" onClick={clearApiKey}>
                  Clear
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => setNewApiKey(e.target.value)}
                  placeholder="leave empty for local servers without auth"
                  data-testid="stt-api-key"
                  className={inputClass}
                />
                <Button onClick={saveApiKey} disabled={!newApiKey.trim()}>
                  Save
                </Button>
                {editingApiKey && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditingApiKey(false);
                      setNewApiKey('');
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Sent as a Bearer token from the Lector server. The browser never reads it back.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
