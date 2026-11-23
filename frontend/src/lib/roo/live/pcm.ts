// Sound as numbers, for talking with Rico out loud: the microphone goes to Google as 16-bit PCM at 16 kHz,
// base64 in JSON; Rico's voice comes back as 16-bit PCM at 24 kHz. Little-endian throughout, as Google sends it.

/** The microphone's rate for Google (it hears 16 kHz). */
export const MIC_RATE = 16_000
/** Rico's voice from Google. */
export const VOICE_RATE = 24_000

/** Web Audio samples (−1 … 1) to 16-bit PCM, clipped. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

/** 16-bit little-endian PCM bytes back to Web Audio samples. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

/** Samples at one rate to another, by straight lines between neighbours: enough for speech. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples
  const n = Math.max(0, Math.round((samples.length * to) / from))
  const out = new Float32Array(n)
  const step = from / to
  for (let i = 0; i < n; i++) {
    const pos = i * step
    const j = Math.floor(pos)
    const a = samples[Math.min(j, samples.length - 1)]
    const b = samples[Math.min(j + 1, samples.length - 1)]
    out[i] = a + (b - a) * (pos - j)
  }
  return out
}

export function toBase64(bytes: Uint8Array): string {
  let text = ''
  // In slices: String.fromCharCode with a whole second of audio would overflow the call stack.
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

export function fromBase64(data: string): Uint8Array {
  const text = atob(data)
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

/** How loud a stretch of sound is (root mean square, 0 … 1). */
export function loudness(samples: Float32Array): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** Microphone samples (at the capture rate) as the base64 PCM chunk Google takes. */
export function micChunk(samples: Float32Array, rate: number): string {
  const pcm = floatToPcm16(resample(samples, rate, MIC_RATE))
  return toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
}
