import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stt = vi.hoisted(() => ({ requestPermissions: vi.fn(), available: vi.fn(), start: vi.fn(), stop: vi.fn(async () => {}) }))
const tts = vi.hoisted(() => {
  const listeners: Array<() => void> = []
  return {
    listeners,
    plugin: {
      speak: vi.fn(),
      stop: vi.fn(async () => {}),
      isLanguageSupported: vi.fn(async () => ({ supported: true })),
      addListener: vi.fn(async (_event: string, fn: () => void) => {
        listeners.push(fn)
        return { remove: vi.fn(async () => {}) }
      }),
    },
  }
})
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: stt }))
vi.mock('@capacitor-community/text-to-speech', () => ({ TextToSpeech: tts.plugin, QueueStrategy: { Flush: 0, Add: 1 } }))

import { VoiceError } from '@/lib/voice'
import { listenOnce, phoneSay } from './speech'

beforeEach(() => {
  vi.clearAllMocks()
  tts.listeners.length = 0
  stt.requestPermissions.mockResolvedValue({ speechRecognition: 'granted' })
  stt.available.mockResolvedValue({ available: true })
})

afterEach(() => vi.useRealTimers())

describe('listening in the app', () => {
  it('hears one sentence in Indian English through Android', async () => {
    stt.start.mockResolvedValue({ matches: ['running late by ten minutes'] })
    await expect(listenOnce()).resolves.toBe('running late by ten minutes')
    expect(stt.start).toHaveBeenCalledWith({ language: 'en-IN', maxResults: 1, partialResults: false, popup: false })
  })

  it('says the microphone is off when Android refuses it', async () => {
    stt.requestPermissions.mockResolvedValue({ speechRecognition: 'denied' })
    const err = await listenOnce().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VoiceError)
    expect((err as Error).message).toBe('The microphone is off for Reroute. Allow it in Android settings to talk to me.')
    expect(stt.start).not.toHaveBeenCalled()
  })

  it("says so when the phone can't listen", async () => {
    stt.available.mockResolvedValue({ available: false })
    await expect(listenOnce()).rejects.toThrow('This phone can’t listen. Tap the buttons instead.')
  })

  it("turns Android's errors into the web's messages", async () => {
    stt.start.mockRejectedValueOnce(new Error('No match'))
    await expect(listenOnce()).rejects.toThrow('I didn’t hear anything. Tap me and try again.')
    stt.start.mockRejectedValueOnce(new Error('Network error'))
    await expect(listenOnce()).rejects.toThrow('Listening needs a connection. Tap the buttons instead.')
    stt.start.mockResolvedValueOnce({ matches: [] })
    await expect(listenOnce()).rejects.toThrow('I didn’t catch that. Tap me and try again.')
  })

  it('gives up after the time allowed, and stops listening', async () => {
    stt.start.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    const heard = listenOnce({ ms: 3000 })
    const settled = expect(heard).rejects.toThrow('I didn’t hear anything. Tap me and try again.')
    await vi.advanceTimersByTimeAsync(3000)
    await settled
    expect(stt.stop).toHaveBeenCalled()
  })

  it('stops at once when the traveller closes Rico, and never settles', async () => {
    stt.start.mockReturnValue(new Promise(() => {}))
    const ctl = new AbortController()
    let settled = false
    void listenOnce({ signal: ctl.signal }).then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.waitFor(() => expect(stt.start).toHaveBeenCalled())
    ctl.abort()
    await new Promise((r) => setTimeout(r, 20))
    expect(stt.stop).toHaveBeenCalled()
    expect(settled).toBe(false)
  })
})

describe("the phone's voice in the app", () => {
  it('speaks the line in Indian English at the chosen speed and volume, then is done', async () => {
    let finish = () => {}
    tts.plugin.speak.mockReturnValue(new Promise<void>((r) => (finish = r)))
    const speech = phoneSay('Time to leave for the bank.', { voiceRate: 'fast', volume: 0.6 })
    await vi.waitFor(() => expect(tts.plugin.speak).toHaveBeenCalled())
    expect(tts.plugin.speak).toHaveBeenCalledWith({ text: 'Time to leave for the bank.', lang: 'en-IN', rate: 1.15, volume: 0.6, queueStrategy: 0 })
    // The first spoken word starts the clock that Rico's mouth follows.
    tts.listeners[0]()
    await expect(speech.started).resolves.toBe(true)
    expect(speech.estimateMs).toBeGreaterThan(0)
    finish()
    await speech.done
  })

  it('uses any English voice when the phone has no Indian English', async () => {
    vi.resetModules()
    tts.plugin.isLanguageSupported.mockResolvedValueOnce({ supported: false })
    tts.plugin.speak.mockResolvedValue(undefined)
    const { phoneSay: fresh } = await import('./speech')
    await fresh('Hello', { voiceRate: 'normal', volume: 1 }).done
    expect(tts.plugin.speak).toHaveBeenCalledWith(expect.objectContaining({ lang: 'en-US', rate: 1 }))
  })

  it("reports that it never started when Android can't speak", async () => {
    tts.plugin.speak.mockRejectedValue(new Error('Not yet initialized or destroyed'))
    const speech = phoneSay('Hello', { voiceRate: 'slow', volume: 1 })
    await expect(speech.started).resolves.toBe(false)
    await speech.done
  })

  it('stops when cancelled', async () => {
    tts.plugin.speak.mockReturnValue(new Promise(() => {}))
    const speech = phoneSay('A long line', { voiceRate: 'normal', volume: 1 })
    speech.cancel()
    await speech.done
    expect(tts.plugin.stop).toHaveBeenCalled()
  })
})
