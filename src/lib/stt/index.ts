import { apiBase, apiFetch } from '@/lib/api-base';
import { Downsampler, Endpointer, floatTo16BitPCM, rms, STT_SAMPLE_RATE } from './audio';

export interface SttStatus {
  source: 'asr' | 'custom';
  protocol: 'http' | 'realtime';
  model: string;
  endpoint: string;
  ok: boolean;
  error?: string;
}

export interface RecognitionHandlers {
  /** `text` is the whole transcript so far, not a delta. */
  onTranscript(text: string, final: boolean): void;
  onError(message: string): void;
  /** Capture stopped, by `stop()` or by the endpointer. The final transcript follows. */
  onCaptureEnd(): void;
  onLevel?(level: number): void;
}

export interface Recognition {
  stop(): void;
  /** Drop the session. No further handler runs. */
  cancel(): void;
}

const SEND_SAMPLES = STT_SAMPLE_RATE / 10;
const WORKLET_NAME = 'lector-capture';
const WORKLET_SOURCE = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1024); this.length = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.length++] = channel[i];
      if (this.length === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', Capture);
`;

let workletUrl: string | null = null;

export function isVoiceInputSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioWorkletNode !== 'undefined'
  );
}

export function sttStreamUrl(language: string, base = apiBase(), page = window.location.href) {
  const url = new URL(`${base}/api/stt/stream`, page);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('language', language);
  return url.toString();
}

export async function getSttStatus(): Promise<SttStatus> {
  const response = await apiFetch('/api/stt/status');
  if (!response.ok) throw new Error(`Status ${response.status}`);
  return response.json();
}

function microphoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it for this site to answer by voice.';
  }
  if (name === 'NotFoundError') return 'No microphone was found.';
  return 'The microphone could not start.';
}

/** Rejects with a readable message when the microphone cannot start. */
export async function startRecognition(
  language: string,
  handlers: RecognitionHandlers,
): Promise<Recognition> {
  let stopped = false;
  let settled = false;
  let release = () => {};
  const pending: ArrayBuffer[] = [];

  const socket = new WebSocket(sttStreamUrl(language));
  socket.binaryType = 'arraybuffer';

  const settle = () => {
    settled = true;
    release();
  };

  socket.onopen = () => {
    for (const buffer of pending) socket.send(buffer);
    pending.length = 0;
    if (stopped) socket.send(JSON.stringify({ type: 'stop' }));
  };
  socket.onmessage = (event) => {
    if (settled || typeof event.data !== 'string') return;
    let message: { type?: string; text?: string; final?: boolean; error?: string };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'transcript') {
      if (message.final) settle();
      handlers.onTranscript(message.text ?? '', message.final === true);
    }
    if (message.type === 'error') {
      settle();
      handlers.onError(message.error || 'Speech recognition failed.');
    }
  };
  socket.onclose = () => {
    if (settled) return;
    settle();
    handlers.onError('Lost the connection to the speech recognizer.');
  };

  const send = (buffer: ArrayBuffer) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(buffer);
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(buffer);
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    settled = true;
    socket.close();
    throw new Error(microphoneError(err));
  }

  const context = new AudioContext();
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  try {
    workletUrl ??= URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    await context.audioWorklet.addModule(workletUrl);
  } catch {
    settled = true;
    stopTracks();
    void context.close();
    socket.close();
    throw new Error('This browser cannot record audio for voice answers.');
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, WORKLET_NAME);
  const downsampler = new Downsampler(context.sampleRate);
  const endpointer = new Endpointer();
  let batch: Int16Array[] = [];
  let batchSamples = 0;

  const flush = () => {
    if (batchSamples === 0) return;
    const merged = new Int16Array(batchSamples);
    let offset = 0;
    for (const part of batch) {
      merged.set(part, offset);
      offset += part.length;
    }
    batch = [];
    batchSamples = 0;
    send(merged.buffer);
  };

  let audioReleased = false;
  const releaseAudio = () => {
    if (audioReleased) return;
    audioReleased = true;
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    stopTracks();
    void context.close();
  };

  const stop = () => {
    if (stopped || settled) return;
    stopped = true;
    flush();
    releaseAudio();
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
    handlers.onCaptureEnd();
  };

  release = () => {
    releaseAudio();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  };

  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (stopped || settled) return;
    const frame = event.data;
    const level = rms(frame);
    handlers.onLevel?.(level);
    const pcm = floatTo16BitPCM(downsampler.process(frame));
    batch.push(pcm);
    batchSamples += pcm.length;
    if (batchSamples >= SEND_SAMPLES) flush();
    if (endpointer.push(level, (frame.length / context.sampleRate) * 1000)) stop();
  };
  source.connect(node);
  node.connect(context.destination);
  void context.resume();

  if (settled) releaseAudio();

  return {
    stop,
    cancel: () => {
      if (settled) return;
      settle();
    },
  };
}
