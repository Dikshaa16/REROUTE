// Talking with Rico out loud, in real time, through Gemini Live. The server hands out a one-use pass
// (POST /v1/roo/live) with Rico's model, voice, instructions and his one tool locked in; this is the
// conversation over it: the microphone going out, Rico's voice coming back as it's made, Google's voice
// activity detection ending each turn (and stopping Rico when the traveller talks over him), the captions,
// and Rico's tool, ask_reroute, which the app runs through his agent.
//
// The socket and the sound are passed in, so all of it runs in tests without a network or a microphone.

import { ChildVoice } from './childVoice'
import { fromBase64, loudness, micChunk, pcm16ToFloat, VOICE_RATE } from './pcm'

export type LiveState = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'ended'

export interface LiveSocket {
  send(data: string): void
  close(): void
}

export interface LiveAudio {
  /** Starts the microphone. Frames of samples arrive about ten times a second, at `rate`. */
  startMic(onFrame: (samples: Float32Array, rate: number) => void): Promise<void>
  stopMic(): void
  /** Queues Rico's voice to play after what's already queued. */
  play(samples: Float32Array, rate: number): void
  /** Stops Rico at once: the traveller talked over him. */
  flush(): void
  /** True while Rico's voice is still playing. */
  playing(): boolean
  close(): void
}

export interface LiveEvents {
  state(s: LiveState): void
  /** A piece of what someone said, as Google transcribes it: pieces of a turn come in order. */
  caption(who: 'you' | 'rico', text: string): void
  /** Rico asks the planner: what it answered, in words for Rico. */
  tool(request: string): Promise<string>
  ended(reason: 'stopped' | 'closed' | 'failed', message?: string): void
  /** How loud the traveller is (0 … 1), for the listening ring. */
  level?(you: number): void
}

/** Talking over Rico: this loud (and for two frames running) counts as the traveller, not Rico's own echo. */
const BARGE_IN = 0.06
/** After the last words heard, this long of nothing more means the traveller has finished: Rico thinks. */
const DONE_TALKING_MS = 800
/** What's said while Rico wakes up is kept for him, this much of it (seconds). */
const EARLY_SECONDS = 8
/** A voice this loud (for a few tenths of a second) while he wakes up means the traveller has started talking. */
const SPEECH = 0.03
const SPEECH_FRAMES = 3

interface FunctionCall {
  id?: string
  name?: string
  args?: Record<string, unknown>
}

export class LiveConversation {
  private current: LiveState = 'connecting'
  private muted = false
  private over = false
  private heardAt = 0
  /** Google says when the traveller starts and stops talking: then that, not a pause in the words, ends their turn. */
  private detecting = false
  /** Rico's planner is still working on what he was asked (Google carries on meanwhile): he's thinking. */
  private planning = 0
  private loudFrames = 0
  private turnEnded = false
  /** Google has set the session up and the microphone is on: what's said goes straight out. */
  private ready = false
  private mic: Promise<void> | null = null
  /** Said while Rico woke up, for him once he's ready; and what the app told him meanwhile. */
  private early: { data: string; seconds: number }[] = []
  private earlySeconds = 0
  private earlyLoud = 0
  private pending: { message: unknown; unlessSpoken: boolean }[] = []
  /** Rico's voice raised to a child's, once it starts. */
  private child: ChildVoice | null = null

  constructor(
    private readonly socket: LiveSocket,
    private readonly audio: LiveAudio,
    private readonly events: LiveEvents,
    private readonly model: string,
    private readonly now: () => number = () => Date.now(),
    /** Semitones Rico's voice is raised by (the pass's `pitch`): Google's voices are grown-ups, Rico is a child. */
    private readonly pitch = 0,
  ) {}

  get state(): LiveState {
    return this.current
  }

  /** The microphone on at once, while the session is still being set up: what's said meanwhile is kept and sent as
   *  soon as Google is ready, so nothing is lost, and the glow round Rico follows the voice from the start. */
  listen() {
    this.mic ??= this.audio.startMic((samples, rate) => this.frame(samples, rate))
    this.mic.catch(() => {})
  }

  /** Whether the traveller started talking while Rico woke up. */
  get spokeEarly(): boolean {
    return this.earlyLoud >= SPEECH_FRAMES
  }

  /** The socket is open: the setup. The pass already locks Rico's voice, instructions and tool. */
  opened() {
    this.send({ setup: { model: `models/${this.model}` } })
  }

  /** One message from Google, as text or a binary frame of JSON. */
  async received(raw: string | ArrayBuffer) {
    if (this.over) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as Record<string, unknown>
    } catch {
      return
    }
    if ('setupComplete' in msg) {
      try {
        this.listen()
        await this.mic
      } catch {
        return this.end('failed', 'Rico needs the microphone to hear you. Allow it, or use the chat.')
      }
      if (this.over) return
      this.ready = true
      this.set('listening')
      // What was said while he woke up, then what the app told him meanwhile (a hello is left out if the traveller
      // is already talking).
      for (const chunk of this.early.splice(0)) this.sendAudio(chunk.data)
      for (const p of this.pending.splice(0)) if (!(p.unlessSpoken && this.spokeEarly)) this.send(p.message)
      return
    }
    // Google's own voice detection, as it happens: the traveller has started, or stopped, talking.
    const activity = (msg.voiceActivity as { type?: string } | undefined)?.type
    if (activity) this.detecting = true
    if (activity === 'ACTIVITY_START' && this.current === 'listening') this.set('hearing')
    if (activity === 'ACTIVITY_END' && this.current === 'hearing') this.set('thinking')
    const call = msg.toolCall as { functionCalls?: FunctionCall[] } | undefined
    if (call?.functionCalls?.length) return void this.runTools(call.functionCalls)
    const sc = msg.serverContent as
      | {
          interrupted?: boolean
          inputTranscription?: { text?: string }
          outputTranscription?: { text?: string }
          modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] }
          turnComplete?: boolean
        }
      | undefined
    if (!sc) return
    if (sc.interrupted) {
      // The traveller talked over Rico: he stops at once and listens.
      this.audio.flush()
      this.child?.reset()
      this.turnEnded = false
      this.rest()
    }
    if (sc.inputTranscription?.text) {
      this.events.caption('you', sc.inputTranscription.text)
      this.heardAt = this.now()
      if (this.current === 'listening' || (this.current === 'thinking' && this.planning)) this.set('hearing')
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data
      if (!data) continue
      const rate = Number(/rate=(\d+)/.exec(part.inlineData?.mimeType ?? '')?.[1] ?? VOICE_RATE)
      this.say(pcm16ToFloat(fromBase64(data)), rate)
      this.turnEnded = false
      this.set('speaking')
    }
    if (sc.outputTranscription?.text) this.events.caption('rico', sc.outputTranscription.text)
    if (sc.turnComplete) {
      // The end of his last word, which raising his voice held back.
      const rest = this.child?.drain()
      if (rest?.length) this.audio.play(rest, this.child!.rate)
      this.turnEnded = true
      if (!this.audio.playing()) this.rest()
    }
  }

  /** The socket closed: by us, or by Google (the session's time is up, or it failed). */
  closed(code: number, reason = '') {
    if (this.over) return
    this.end(code === 1000 ? 'closed' : 'failed', reason || undefined)
  }

  /** Mute the microphone: Rico hears nothing until it's on again. */
  mute(on: boolean) {
    this.muted = on
  }

  /** Something typed instead of said: Rico answers out loud all the same. */
  sendText(text: string) {
    const words = text.trim()
    if (!words || this.over) return
    this.audio.flush()
    this.child?.reset()
    this.post({ clientContent: { turns: [{ role: 'user', parts: [{ text: words }] }], turnComplete: true } })
    this.set('thinking')
  }

  /** Tells Rico something happened (the traveller tapped "Do it" on his card), for him to say it; with `unlessSpoken`,
   *  only if the traveller didn't start talking while he woke up (a hello). */
  note(text: string, unlessSpoken = false) {
    if (this.over) return
    this.post({ clientContent: { turns: [{ role: 'user', parts: [{ text: `(What just happened in the app: ${text})` }] }], turnComplete: true } }, unlessSpoken)
  }

  /** To Google now, or once the session is ready. */
  private post(message: unknown, unlessSpoken = false) {
    if (this.ready) this.send(message)
    else this.pending.push({ message, unlessSpoken })
  }

  stop() {
    this.end('stopped')
  }

  /** One frame from the microphone: out to Google, unless muted, or while Rico talks and it's only his echo. */
  private frame(samples: Float32Array, rate: number) {
    if (this.over) return
    const level = loudness(samples)
    this.events.level?.(this.muted ? 0 : level)
    if (!this.ready) {
      // Rico is still waking up: the last few seconds are kept for him.
      if (this.muted) return
      this.earlyLoud = level > SPEECH ? this.earlyLoud + 1 : this.spokeEarly ? this.earlyLoud : 0
      this.early.push({ data: micChunk(samples, rate), seconds: samples.length / rate })
      this.earlySeconds += samples.length / rate
      while (this.earlySeconds > EARLY_SECONDS && this.early.length > 1) this.earlySeconds -= this.early.shift()!.seconds
      return
    }
    if (this.current === 'speaking' && this.turnEnded && !this.audio.playing()) {
      this.turnEnded = false
      this.rest()
    }
    if (this.current === 'hearing' && !this.detecting && this.now() - this.heardAt > DONE_TALKING_MS) this.set('thinking')
    if (this.muted) return
    if (this.audio.playing()) {
      // While Rico talks, the microphone also hears his voice: only a clear voice over it goes out, so Google's
      // voice detection hears the traveller cutting in, never Rico interrupting himself.
      this.loudFrames = level > BARGE_IN ? this.loudFrames + 1 : 0
      if (this.loudFrames < 2) return
    }
    this.sendAudio(micChunk(samples, rate))
  }

  /** Rico's voice out, raised to a child's first when the pass says so. Raising it holds back a few hundredths of a
   *  second at a time, so a chunk can come out empty. */
  private say(samples: Float32Array, rate: number) {
    if (this.pitch) {
      if (this.child?.rate !== rate) this.child = new ChildVoice(this.pitch, rate)
      samples = this.child.push(samples)
    }
    if (samples.length) this.audio.play(samples, rate)
  }

  private sendAudio(data: string) {
    this.send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } })
  }

  private async runTools(calls: FunctionCall[]) {
    this.planning++
    this.set('thinking')
    const responses = []
    for (const call of calls) {
      let result: string
      if (call.name !== 'ask_reroute') result = `There's no tool called ${call.name ?? 'that'}.`
      else {
        try {
          result = await this.events.tool(String(call.args?.request ?? ''))
        } catch {
          result = "Reroute couldn't be reached just now. Say so, and offer the chat instead."
        }
      }
      responses.push({ id: call.id, name: call.name, response: { result } })
    }
    this.planning--
    if (!this.over) this.send({ toolResponse: { functionResponses: responses } })
  }

  /** Between turns: listening, or thinking while his planner still works on something. */
  private rest() {
    this.set(this.planning > 0 ? 'thinking' : 'listening')
  }

  private set(next: LiveState) {
    if (this.over || next === this.current) return
    this.current = next
    this.events.state(next)
  }

  private send(message: unknown) {
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      /* the socket is closing: its close event ends the conversation */
    }
  }

  private end(reason: 'stopped' | 'closed' | 'failed', message?: string) {
    if (this.over) return
    this.set('ended')
    this.over = true
    this.audio.stopMic()
    this.audio.flush()
    this.audio.close()
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
    this.events.ended(reason, message)
  }
}
