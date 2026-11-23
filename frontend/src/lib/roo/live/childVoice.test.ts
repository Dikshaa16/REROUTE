import { describe, expect, it } from 'vitest'
import { pitchOf, RATE, tone } from '@/test/sound'
import { ChildVoice } from './childVoice'

function join(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The voice raised, coming in chunks of `chunk`, and played out at the end. */
function raise(samples: Float32Array, semitones: number, chunk: number): Float32Array {
  const voice = new ChildVoice(semitones, RATE)
  const parts: Float32Array[] = []
  for (let i = 0; i < samples.length; i += chunk) parts.push(voice.push(samples.subarray(i, i + chunk)))
  parts.push(voice.drain())
  return join(parts)
}

function rms(s: Float32Array): number {
  let sum = 0
  for (const x of s) sum += x * x
  return Math.sqrt(sum / s.length)
}

describe('Rico’s live voice as a child’s', () => {
  it('raises a voice by the semitones asked, at the same speed', () => {
    const voice = tone(200, 1)
    for (const semitones of [3, 4, 5]) {
      const out = raise(voice, semitones, 960)
      expect(pitchOf(out) / (200 * 2 ** (semitones / 12))).toBeCloseTo(1, 1)
      expect(Math.abs(out.length - voice.length)).toBeLessThan(voice.length * 0.02)
    }
  })

  it('keeps the voice as loud as it was', () => {
    const out = raise(tone(220, 1), 4, 960)
    expect(rms(out.subarray(2400, 21600)) / rms(tone(220, 1))).toBeGreaterThan(0.85)
    expect(rms(out.subarray(2400, 21600)) / rms(tone(220, 1))).toBeLessThan(1.15)
  })

  it('sounds the same however the voice is cut into chunks', () => {
    const voice = tone(180, 0.6)
    const whole = raise(voice, 4, voice.length)
    for (const chunk of [37, 960, 4800]) {
      const out = raise(voice, 4, chunk)
      expect(Math.abs(out.length - whole.length)).toBeLessThanOrEqual(1)
      let worst = 0
      for (let i = 0; i < Math.min(out.length, whole.length); i++) worst = Math.max(worst, Math.abs(out[i] - whole[i]))
      expect(worst).toBeLessThan(1e-3)
    }
  })

  it('holds back a moment, plays it out at the end of a turn, and drops it when stopped', () => {
    const voice = new ChildVoice(4, RATE)
    const first = voice.push(tone(200, 0.1))
    expect(first.length).toBeLessThan(2400)
    expect(first.length + voice.drain().length).toBeGreaterThanOrEqual(2400)
    // Nothing new since: nothing more to play.
    expect(voice.drain().length).toBe(0)
    voice.push(tone(200, 0.1))
    voice.reset()
    expect(voice.drain().length).toBe(0)
  })

  it('plays a voice as it is at 0 semitones', () => {
    const voice = new ChildVoice(0, RATE)
    const samples = tone(200, 0.1)
    expect(voice.push(samples)).toBe(samples)
    expect(voice.drain().length).toBe(0)
  })
})
