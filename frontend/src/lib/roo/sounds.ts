// Rico's little sounds: a pop as he appears, a blip when he starts listening, soft pips while he thinks, a
// happy chirp, a giggle when he's booped and a sleepy "bwoo" as he leaves. Made on the spot with Web Audio,
// like the alert chimes (no sound files), at the traveller's alert volume, and silent when sounds are off.

import { getState } from '@/lib/store'

export type RicoSound = 'appear' | 'listen' | 'think' | 'happy' | 'giggle' | 'bye'

interface Note {
  /** Start, after the sound begins (s). */
  at: number
  /** Pitch at the start and at the end of the note (Hz): a slide makes it cute. */
  from: number
  to: number
  /** Length (s). */
  len: number
  wave?: OscillatorType
  /** Loudness of this note against the others (0 … 1). */
  level?: number
}

/** Each sound as notes. Short, high and bouncy, like a small creature, never an alarm. */
export const SOUNDS: Record<RicoSound, Note[]> = {
  appear: [
    { at: 0, from: 420, to: 980, len: 0.12, wave: 'triangle' },
    { at: 0.11, from: 1180, to: 1320, len: 0.1, wave: 'sine', level: 0.8 },
  ],
  listen: [{ at: 0, from: 880, to: 1040, len: 0.07, wave: 'sine', level: 0.6 }],
  think: [
    { at: 0, from: 700, to: 700, len: 0.05, wave: 'sine', level: 0.35 },
    { at: 0.1, from: 820, to: 820, len: 0.05, wave: 'sine', level: 0.35 },
    { at: 0.2, from: 940, to: 940, len: 0.05, wave: 'sine', level: 0.35 },
  ],
  happy: [
    { at: 0, from: 990, to: 1100, len: 0.08, wave: 'triangle' },
    { at: 0.09, from: 1320, to: 1480, len: 0.12, wave: 'triangle', level: 0.9 },
  ],
  giggle: [0, 0.07, 0.14, 0.21, 0.28].map((at, i) => ({ at, from: i % 2 ? 1400 : 1150, to: i % 2 ? 1250 : 1300, len: 0.05, wave: 'triangle' as const, level: 0.7 })),
  bye: [{ at: 0, from: 900, to: 420, len: 0.22, wave: 'triangle' }],
}

let audio: AudioContext | null = null

function context(): AudioContext | null {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  audio ??= new Ctor()
  void audio.resume().catch(() => {})
  return audio
}

/** Plays one of Rico's sounds, unless the traveller has alert sounds off. */
export function ricoSound(kind: RicoSound) {
  const prefs = getState().alerts
  if (!prefs.sound || prefs.volume <= 0) return
  const ctx = context()
  if (!ctx) return
  const peak = Math.max(0.0002, prefs.volume * 0.22)
  const start = ctx.currentTime + 0.01
  for (const n of SOUNDS[kind]) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = start + n.at
    osc.type = n.wave ?? 'sine'
    osc.frequency.setValueAtTime(n.from, t)
    osc.frequency.exponentialRampToValueAtTime(n.to, t + n.len)
    const level = peak * (n.level ?? 1)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(level, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + n.len)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + n.len + 0.02)
  }
}
