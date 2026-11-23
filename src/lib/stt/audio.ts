/** Sample rate the /api/stt/stream WebSocket expects. Mirrors STT_SAMPLE_RATE in api/src/lib/stt.ts. */
export const STT_SAMPLE_RATE = 16_000;

/** Streaming box-filter resampler. Keeps its phase across chunks, so chunk size does not matter. */
export class Downsampler {
  private carry = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;

  constructor(inputRate: number, outputRate = STT_SAMPLE_RATE) {
    this.ratio = inputRate / outputRate;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const buffer = new Float32Array(this.carry.length + input.length);
    buffer.set(this.carry);
    buffer.set(input, this.carry.length);

    const out: number[] = [];
    let t = this.position;
    while (t + this.ratio <= buffer.length) {
      const start = Math.floor(t);
      const end = Math.max(start + 1, Math.floor(t + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buffer[i];
      out.push(sum / (end - start));
      t += this.ratio;
    }
    const consumed = Math.floor(t);
    this.carry = buffer.slice(consumed);
    this.position = t - consumed;
    return Float32Array.from(out);
  }
}

export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export interface EndpointerOptions {
  /** RMS level (0..1) that counts as speech. */
  threshold: number;
  /** Silence after speech that ends the capture. */
  silenceMs: number;
  /** Capture length with no speech at all before giving up. */
  noSpeechMs: number;
  maxMs: number;
}

export const DEFAULT_ENDPOINTING: EndpointerOptions = {
  threshold: 0.015,
  silenceMs: 1_500,
  noSpeechMs: 8_000,
  maxMs: 15_000,
};

/** Decides when the learner has finished speaking. */
export class Endpointer {
  private elapsed = 0;
  private silence = 0;
  private heardSpeech = false;

  constructor(private readonly options: EndpointerOptions = DEFAULT_ENDPOINTING) {}

  /** Feed one frame; true once the capture should stop. */
  push(level: number, durationMs: number): boolean {
    this.elapsed += durationMs;
    if (level >= this.options.threshold) {
      this.heardSpeech = true;
      this.silence = 0;
    } else {
      this.silence += durationMs;
    }
    if (this.elapsed >= this.options.maxMs) return true;
    return this.heardSpeech
      ? this.silence >= this.options.silenceMs
      : this.elapsed >= this.options.noSpeechMs;
  }
}

/** Mono 16-bit PCM chunks as a WAV file. */
export function encodeWav(chunks: readonly Int16Array[], sampleRate = STT_SAMPLE_RATE): Blob {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) =>
    [...value].forEach((ch, i) => header.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, samples * 2, true);
  return new Blob([header.buffer, ...chunks.map((c) => c.buffer as ArrayBuffer)], {
    type: 'audio/wav',
  });
}
