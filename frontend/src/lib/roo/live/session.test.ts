import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { pitchOf, tone } from '@/test/sound'
import { floatToPcm16, fromBase64, toBase64 } from './pcm'
import { LiveConversation, type LiveAudio, type LiveEvents, type LiveState } from './session'

class FakeAudio implements LiveAudio {
  onFrame: ((samples: Float32Array, rate: number) => void) | null = null
  played: { samples: Float32Array; rate: number }[] = []
  flushed = 0
  closed = false
  micOn = false
  isPlaying = false
  failMic = false

  async startMic(onFrame: (samples: Float32Array, rate: number) => void) {
    if (this.failMic) throw new Error('denied')
    this.onFrame = onFrame
    this.micOn = true
  }
  stopMic() {
    this.micOn = false
  }
  play(samples: Float32Array, rate: number) {
    this.played.push({ samples, rate })
    this.isPlaying = true
  }
  flush() {
    this.flushed++
    this.isPlaying = false
  }
  playing() {
    return this.isPlaying
  }
  close() {
    this.closed = true
  }
}

let sent: Record<string, unknown>[]
let socket: { send: (d: string) => void; close: () => void; closed: boolean }
let audio: FakeAudio
let states: LiveState[]
let captions: [string, string][]
let ended: [string, string | undefined][]
let tool: Mock<(request: string) => Promise<string>>
let clock: number
let talk: LiveConversation

const frame = (level: number) => new Float32Array(1600).fill(level)
const msg = (m: unknown) => talk.received(JSON.stringify(m))
const voice = (samples: number[]) => {
  const pcm = new Int16Array(samples)
  return toBase64(new Uint8Array(pcm.buffer))
}

beforeEach(async () => {
  sent = []
  socket = { send: (d) => sent.push(JSON.parse(d) as Record<string, unknown>), close: () => (socket.closed = true), closed: false }
  audio = new FakeAudio()
  states = []
  captions = []
  ended = []
  tool = vi.fn(async (request: string) => `Planner says: ${request}`)
  clock = 0
  const events: LiveEvents = {
    state: (s) => states.push(s),
    caption: (who, text) => captions.push([who, text]),
    tool,
    ended: (reason, message) => ended.push([reason, message]),
  }
  talk = new LiveConversation(socket, audio, events, 'gemini-live-test', () => clock)
  talk.opened()
  await msg({ setupComplete: {} })
})

describe('talking with Rico out loud', () => {
  it('sets up with the model, then listens with the microphone on', () => {
    expect(sent[0]).toEqual({ setup: { model: 'models/gemini-live-test' } })
    expect(audio.micOn).toBe(true)
    expect(talk.state).toBe('listening')
  })

  it('sends the microphone out as 16 kHz PCM, and nothing while muted', () => {
    audio.onFrame!(frame(0.01), 16000)
    const out = sent[1] as { realtimeInput: { audio: { data: string; mimeType: string } } }
    expect(out.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000')
    expect(fromBase64(out.realtimeInput.audio.data).length).toBe(3200)
    talk.mute(true)
    audio.onFrame!(frame(0.3), 16000)
    expect(sent).toHaveLength(2)
  })

  it('captions both sides, plays Rico at the rate Google says, and thinks after the traveller stops', async () => {
    await msg({ serverContent: { inputTranscription: { text: 'Hey Rico' } } })
    expect(talk.state).toBe('hearing')
    clock = 900
    audio.onFrame!(frame(0), 16000)
    expect(talk.state).toBe('thinking')
    await msg({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: voice([16384, -16384]) } }] }, outputTranscription: { text: 'Hi there!' } } })
    expect(talk.state).toBe('speaking')
    expect(audio.played[0].rate).toBe(24000)
    expect(audio.played[0].samples[0]).toBeCloseTo(0.5)
    expect(captions).toEqual([
      ['you', 'Hey Rico'],
      ['rico', 'Hi there!'],
    ])
  })

  it('waits for Rico to finish talking before listening again', async () => {
    await msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice([1, 2]) } }] } } })
    await msg({ serverContent: { turnComplete: true } })
    expect(talk.state).toBe('speaking')
    audio.isPlaying = false
    audio.onFrame!(frame(0), 16000)
    expect(talk.state).toBe('listening')
  })

  it('stops Rico at once when the traveller talks over him', async () => {
    await msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice([1]) } }] } } })
    await msg({ serverContent: { interrupted: true } })
    expect(audio.flushed).toBe(1)
    expect(talk.state).toBe('listening')
  })

  it('raises Rico’s voice to a child’s when the pass asks, and ends each turn with what that held back', async () => {
    const out = new FakeAudio()
    const child = new LiveConversation(socket, out, { state: () => {}, caption: () => {}, tool, ended: () => {} }, 'm', () => clock, 4)
    child.opened()
    await child.received(JSON.stringify({ setupComplete: {} }))
    const said = tone(200, 0.5)
    for (let i = 0; i < said.length; i += 2400) {
      const pcm = floatToPcm16(said.subarray(i, i + 2400))
      const data = toBase64(new Uint8Array(pcm.buffer))
      await child.received(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }] } } }))
    }
    const beforeEnd = out.played.length
    await child.received(JSON.stringify({ serverContent: { turnComplete: true } }))
    expect(out.played.length).toBe(beforeEnd + 1)
    const heard = new Float32Array(out.played.reduce((n, p) => n + p.samples.length, 0))
    let at = 0
    for (const p of out.played) {
      expect(p.rate).toBe(24000)
      heard.set(p.samples, at)
      at += p.samples.length
    }
    // Four semitones up (200 Hz → 252 Hz), and as long as Google's voice was.
    expect(pitchOf(heard) / 252).toBeCloseTo(1, 1)
    expect(Math.abs(heard.length - said.length)).toBeLessThan(said.length * 0.02)
    // Talked over: what was held back is dropped, not played after he stopped.
    await child.received(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice(Array(2400).fill(8000)) } }] } } }))
    await child.received(JSON.stringify({ serverContent: { interrupted: true } }))
    const stopped = out.played.length
    await child.received(JSON.stringify({ serverContent: { turnComplete: true } }))
    expect(out.played.length).toBe(stopped)
  })

  it("doesn't let Rico's own echo cut him off, but a clear voice over him does", async () => {
    await msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice([1]) } }] } } })
    const before = sent.length
    audio.onFrame!(frame(0.02), 16000)
    audio.onFrame!(frame(0.02), 16000)
    expect(sent).toHaveLength(before)
    audio.onFrame!(frame(0.2), 16000)
    expect(sent).toHaveLength(before)
    audio.onFrame!(frame(0.2), 16000)
    expect(sent).toHaveLength(before + 1)
  })

  it("runs Rico's tool through the planner and answers Google with what it said", async () => {
    await msg({ toolCall: { functionCalls: [{ id: 'c1', name: 'ask_reroute', args: { request: 'skip the bank' } }, { id: 'c2', name: 'hack' }] } })
    await vi.waitFor(() => expect(sent.some((m) => 'toolResponse' in m)).toBe(true))
    expect(tool).toHaveBeenCalledWith('skip the bank')
    const reply = sent.find((m) => 'toolResponse' in m) as { toolResponse: { functionResponses: { id: string; response: { result: string } }[] } }
    expect(reply.toolResponse.functionResponses[0]).toEqual({ id: 'c1', name: 'ask_reroute', response: { result: 'Planner says: skip the bank' } })
    expect(reply.toolResponse.functionResponses[1].response.result).toMatch(/no tool/)
  })

  it('tells Rico when the planner could not be reached', async () => {
    tool.mockRejectedValueOnce(new Error('offline'))
    await msg({ toolCall: { functionCalls: [{ id: 'c1', name: 'ask_reroute', args: { request: 'book a cab' } }] } })
    await vi.waitFor(() => expect(sent.some((m) => 'toolResponse' in m)).toBe(true))
    expect(JSON.stringify(sent[sent.length - 1])).toMatch(/couldn't be reached/)
  })

  it('takes typed words and notes from the app as turns', () => {
    talk.sendText('  how long to the airport?  ')
    expect(sent[sent.length - 1]).toEqual({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'how long to the airport?' }] }], turnComplete: true } })
    expect(talk.state).toBe('thinking')
    talk.note('the card ran')
    expect(JSON.stringify(sent[sent.length - 1])).toMatch(/What just happened in the app: the card ran/)
  })

  it('reads binary frames as well as text', async () => {
    await talk.received(new TextEncoder().encode(JSON.stringify({ serverContent: { outputTranscription: { text: 'ok' } } })).buffer)
    expect(captions).toEqual([['rico', 'ok']])
  })

  it('ends cleanly when stopped, and says why when Google closes', () => {
    talk.stop()
    expect(ended).toEqual([['stopped', undefined]])
    expect(socket.closed && audio.closed && !audio.micOn).toBe(true)
    expect(states[states.length - 1]).toBe('ended')
    // Nothing after the end.
    talk.closed(1011, 'late')
    expect(ended).toHaveLength(1)
  })

  it('reports a session Google ended as failed, with its reason', () => {
    talk.closed(1011, 'Quota exceeded')
    expect(ended).toEqual([['failed', 'Quota exceeded']])
  })
})

describe('while Rico wakes up', () => {
  const fresh = () => {
    const out: Record<string, unknown>[] = []
    const ear = new FakeAudio()
    const seen: LiveState[] = []
    const sock = { send: (d: string) => out.push(JSON.parse(d) as Record<string, unknown>), close: () => {} }
    const t = new LiveConversation(sock, ear, { state: (x) => seen.push(x), caption: () => {}, tool, ended: () => {} }, 'm')
    return { t, ear, out, seen }
  }

  it('hears from the start: what is said before Google is ready goes to him once it is', async () => {
    const { t, ear, out } = fresh()
    t.listen()
    await Promise.resolve()
    expect(ear.micOn).toBe(true)
    ear.onFrame!(frame(0.2), 16000)
    ear.onFrame!(frame(0.2), 16000)
    t.opened()
    expect(out).toHaveLength(1)
    await t.received(JSON.stringify({ setupComplete: {} }))
    expect(t.state).toBe('listening')
    expect(out.slice(1).map((m) => Object.keys(m)[0])).toEqual(['realtimeInput', 'realtimeInput'])
  })

  it('keeps notes from the app until he is ready, and leaves out a hello once the traveller is talking', async () => {
    const quiet = fresh()
    quiet.t.listen()
    await Promise.resolve()
    quiet.t.note('called by name', true)
    quiet.t.note('a nudge')
    quiet.t.opened()
    expect(quiet.out).toHaveLength(1)
    await quiet.t.received(JSON.stringify({ setupComplete: {} }))
    expect(quiet.out.filter((m) => 'clientContent' in m)).toHaveLength(2)

    const talking = fresh()
    talking.t.listen()
    await Promise.resolve()
    for (let i = 0; i < 4; i++) talking.ear.onFrame!(frame(0.2), 16000)
    expect(talking.t.spokeEarly).toBe(true)
    talking.t.note('called by name', true)
    talking.t.note('a nudge')
    talking.t.opened()
    await talking.t.received(JSON.stringify({ setupComplete: {} }))
    const notes = talking.out.filter((m) => 'clientContent' in m)
    expect(notes).toHaveLength(1)
    expect(JSON.stringify(notes[0])).toContain('a nudge')
  })

  it('keeps only the last few seconds', async () => {
    const { t, ear, out } = fresh()
    t.listen()
    await Promise.resolve()
    // A tenth of a second a frame: 12 seconds of it.
    for (let i = 0; i < 120; i++) ear.onFrame!(frame(0.01), 16000)
    t.opened()
    await t.received(JSON.stringify({ setupComplete: {} }))
    expect(out.filter((m) => 'realtimeInput' in m)).toHaveLength(80)
  })
})

describe('while his planner works', () => {
  it('stays thinking when Google ends its turn before the planner answers', async () => {
    let answer: (s: string) => void = () => {}
    tool.mockImplementation(() => new Promise<string>((r) => (answer = r)))
    await msg({ toolCall: { functionCalls: [{ id: 'c1', name: 'ask_reroute', args: { request: 'skip the bank' } }] } })
    expect(talk.state).toBe('thinking')
    // Gemini 3.8 runs tools in the background: its turn ends at once.
    await msg({ serverContent: { generationComplete: true, turnComplete: true } })
    expect(talk.state).toBe('thinking')
    answer('Skipped')
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.some((m) => 'toolResponse' in m)).toBe(true)
    await msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice([1, 2]) } }] } } })
    expect(talk.state).toBe('speaking')
    audio.isPlaying = false
    await msg({ serverContent: { turnComplete: true } })
    expect(talk.state).toBe('listening')
  })
})

describe("Google's voice detection", () => {
  it('shows the traveller talking the moment they start, and Rico thinking when they stop', async () => {
    await msg({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_START' } })
    expect(talk.state).toBe('hearing')
    // A pause between words isn't the end of their turn: Google says when it is.
    clock = 5000
    audio.onFrame!(frame(0), 16000)
    expect(talk.state).toBe('hearing')
    await msg({ serverContent: {}, voiceActivity: { type: 'ACTIVITY_END' } })
    expect(talk.state).toBe('thinking')
    await msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: voice([1, 2]) } }] } } })
    expect(talk.state).toBe('speaking')
  })
})

describe('without the microphone', () => {
  it('ends, asking for it', async () => {
    const fail = new FakeAudio()
    fail.failMic = true
    const done: string[] = []
    const t = new LiveConversation(socket, fail, { state: () => {}, caption: () => {}, tool, ended: (_r, m) => done.push(m ?? '') }, 'm')
    await t.received(JSON.stringify({ setupComplete: {} }))
    expect(done[0]).toMatch(/microphone/)
    expect(t.state).toBe('ended')
  })
})
