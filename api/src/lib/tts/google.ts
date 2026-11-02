const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

interface SynthesizeRequest {
  input: { text: string };
  voice: { languageCode: string; name?: string };
  audioConfig: {
    audioEncoding: 'MP3';
    speakingRate?: number;
    pitch?: number;
  };
}

export class GoogleTtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleTtsError';
  }
}

export interface GoogleSynthesis {
  apiKey: string;
  text: string;
  languageCode: string;
  voiceName?: string;
  /** Chirp 3 HD voices reject speakingRate and pitch, so leave both unset for them. */
  speakingRate?: number;
  pitch?: number;
}

/** Synthesize MP3 with Google Cloud TTS. Returns the base64 audio. */
export async function synthesizeWithGoogle(
  options: GoogleSynthesis,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const audioConfig: SynthesizeRequest['audioConfig'] = { audioEncoding: 'MP3' };
  if (options.speakingRate !== undefined) audioConfig.speakingRate = options.speakingRate;
  if (options.pitch !== undefined) audioConfig.pitch = options.pitch;
  const request: SynthesizeRequest = {
    input: { text: options.text },
    voice: { languageCode: options.languageCode, name: options.voiceName },
    audioConfig,
  };

  const response = await fetchImpl(`${GOOGLE_TTS_URL}?key=${options.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new GoogleTtsError(error.error?.message || 'TTS API error', response.status);
  }
  const data = await response.json();
  if (!data.audioContent) throw new GoogleTtsError('No audio content returned', 500);
  return data.audioContent as string;
}
