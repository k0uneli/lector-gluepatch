import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINTING,
  Downsampler,
  encodeWav,
  Endpointer,
  floatTo16BitPCM,
  rms,
} from './audio';

function chunked(downsampler: Downsampler, input: Float32Array, size: number): Float32Array {
  const parts: number[] = [];
  for (let i = 0; i < input.length; i += size) {
    parts.push(...downsampler.process(input.subarray(i, i + size)));
  }
  return Float32Array.from(parts);
}

describe('Downsampler', () => {
  it('takes 48 kHz to 16 kHz by averaging each group of three samples', () => {
    const out = new Downsampler(48_000).process(Float32Array.from([0, 0.3, 0.6, 1, 1, 1]));
    expect([...out].map((v) => Number(v.toFixed(4)))).toEqual([0.3, 1]);
  });

  it('gives the same output whatever the chunk size', () => {
    const input = Float32Array.from({ length: 4_800 }, (_, i) => Math.sin(i / 7));
    const whole = new Downsampler(48_000).process(input);
    const pieces = chunked(new Downsampler(48_000), input, 128);
    expect(pieces.length).toBe(1_600);
    expect([...pieces]).toEqual([...whole]);
  });

  it('keeps the phase for a fractional ratio', () => {
    const input = new Float32Array(44_100).fill(0.5);
    const out = chunked(new Downsampler(44_100), input, 1_024);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('passes 16 kHz through unchanged', () => {
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    expect([...new Downsampler(16_000).process(input)]).toEqual([...input]);
  });
});

describe('floatTo16BitPCM', () => {
  it('scales to the int16 range and clamps', () => {
    expect([...floatTo16BitPCM(Float32Array.from([0, 1, -1, 2, -2, 0.5]))]).toEqual([
      0, 32767, -32768, 32767, -32768, 16383,
    ]);
  });
});

describe('rms', () => {
  it('measures the level of a frame', () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe('Endpointer', () => {
  const options = { threshold: 0.1, silenceMs: 300, noSpeechMs: 1_000, maxMs: 5_000 };

  it('stops after a pause that follows speech', () => {
    const endpointer = new Endpointer(options);
    expect(endpointer.push(0.5, 100)).toBe(false);
    expect(endpointer.push(0.01, 100)).toBe(false);
    expect(endpointer.push(0.01, 100)).toBe(false);
    expect(endpointer.push(0.01, 100)).toBe(true);
  });

  it('restarts the pause when speech resumes', () => {
    const endpointer = new Endpointer(options);
    endpointer.push(0.5, 100);
    endpointer.push(0.01, 200);
    expect(endpointer.push(0.5, 100)).toBe(false);
    expect(endpointer.push(0.01, 200)).toBe(false);
  });

  it('gives up when nobody speaks', () => {
    const endpointer = new Endpointer(options);
    expect(endpointer.push(0.01, 900)).toBe(false);
    expect(endpointer.push(0.01, 100)).toBe(true);
  });

  it('stops at the length cap even mid-speech', () => {
    const endpointer = new Endpointer(options);
    expect(endpointer.push(0.5, 4_900)).toBe(false);
    expect(endpointer.push(0.5, 100)).toBe(true);
  });
});

describe('Endpointer options', () => {
  it('waits out a longer pause when asked to', () => {
    const endpointer = new Endpointer({ ...DEFAULT_ENDPOINTING, silenceMs: 2_500 });
    expect(endpointer.push(0.1, 500)).toBe(false);
    expect(endpointer.push(0, 2_000)).toBe(false);
    expect(endpointer.push(0, 600)).toBe(true);
  });

  it('never stops on silence in manual mode, only at the cap', () => {
    const endpointer = new Endpointer({
      ...DEFAULT_ENDPOINTING,
      silenceMs: Infinity,
      noSpeechMs: Infinity,
      maxMs: 120_000,
    });
    expect(endpointer.push(0.1, 500)).toBe(false);
    expect(endpointer.push(0, 60_000)).toBe(false);
    expect(endpointer.push(0, 60_000)).toBe(true);
  });
});

describe('encodeWav', () => {
  it('wraps 16-bit mono PCM in a WAV header', async () => {
    const blob = encodeWav([new Int16Array([1, -1]), new Int16Array([256])]);
    expect(blob.type).toBe('audio/wav');
    const view = new DataView(await blob.arrayBuffer());
    const text = (offset: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.byteLength).toBe(50);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([
      1, -1, 256,
    ]);
  });
});
