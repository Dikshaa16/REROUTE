import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getState, setState } from '@/lib/store'
import { ricoSound, SOUNDS } from './sounds'

const made = { oscillators: 0, ctx: 0 }

class FakeContext {
  currentTime = 0
  destination = {}
  constructor() {
    made.ctx++
  }
  resume() {
    return Promise.resolve()
  }
  createOscillator() {
    made.oscillators++
    return { type: '', frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n, start: vi.fn(), stop: vi.fn() }
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n }
  }
}

const alerts = getState().alerts

beforeEach(() => {
  made.oscillators = 0
  vi.stubGlobal('AudioContext', FakeContext)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setState({ alerts })
})

describe("Rico's little sounds", () => {
  it('plays each note of a sound', () => {
    setState({ alerts: { ...alerts, sound: true, volume: 0.6 } })
    ricoSound('giggle')
    expect(made.oscillators).toBe(SOUNDS.giggle.length)
  })

  it('stays quiet when alert sounds are off, or the volume is down', () => {
    setState({ alerts: { ...alerts, sound: false } })
    ricoSound('appear')
    setState({ alerts: { ...alerts, sound: true, volume: 0 } })
    ricoSound('appear')
    expect(made.oscillators).toBe(0)
  })

  it('keeps every sound short and high, like a small creature', () => {
    for (const notes of Object.values(SOUNDS)) {
      const end = Math.max(...notes.map((n) => n.at + n.len))
      expect(end).toBeLessThan(0.5)
      for (const n of notes) expect(Math.min(n.from, n.to)).toBeGreaterThanOrEqual(400)
    }
  })
})
