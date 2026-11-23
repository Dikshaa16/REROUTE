// The sound side of talking with Rico out loud, in Web Audio: the microphone in (with the browser's echo
// cancellation, so Rico doesn't hear himself), Rico's voice out, chunk after chunk with no gaps, and how loud
// he is at each moment, which moves his mouth.

import type { MouthParams } from '@/lib/roo/lipsync/mouth'
import type { LiveAudio } from './session'

/** Rico's mouth from how loud his voice is: open with the sound, a little rounder on the loud parts. */
export function mouthFor(level: number, t: number): MouthParams {
  const open = Math.min(1, level * 5.5)
  return { open, wide: 0.15 * Math.sin(t / 90), round: 0.3 * open * (0.5 + 0.5 * Math.sin(t / 140)), smile: 0.3 }
}

export class WebLiveAudio implements LiveAudio {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private mic: MediaStreamAudioSourceNode | null = null
  private tap: AudioNode | null = null
  private analyser: AnalyserNode | null = null
  private nextAt = 0
  private readonly voices = new Set<AudioBufferSourceNode>()
  private readonly wave = new Float32Array(512)

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 512
      this.analyser.connect(this.ctx.destination)
    }
    void this.ctx.resume().catch(() => {})
    return this.ctx
  }

  async startMic(onFrame: (samples: Float32Array, rate: number) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const ctx = this.context()
    this.mic = ctx.createMediaStreamSource(this.stream)
    // Nothing from the microphone reaches the speaker: the tap ends in silence.
    const silent = ctx.createGain()
    silent.gain.value = 0
    silent.connect(ctx.destination)
    try {
      await ctx.audioWorklet.addModule('/audio/rico-mic.js')
      const node = new AudioWorkletNode(ctx, 'rico-mic')
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data, ctx.sampleRate)
      this.tap = node
    } catch {
      // No audio worklets here: the older processor does the same, on the page's own thread.
      const node = ctx.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate)
      this.tap = node
    }
    this.mic.connect(this.tap)
    this.tap.connect(silent)
  }

  stopMic() {
    this.mic?.disconnect()
    this.tap?.disconnect()
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.mic = null
    this.tap = null
  }

  play(samples: Float32Array, rate: number) {
    const ctx = this.context()
    const buffer = ctx.createBuffer(1, samples.length, rate)
    buffer.getChannelData(0).set(samples)
    const voice = ctx.createBufferSource()
    voice.buffer = buffer
    voice.connect(this.analyser!)
    // Each chunk starts as the one before ends; after a pause, a moment from now.
    const at = Math.max(ctx.currentTime + 0.03, this.nextAt)
    voice.start(at)
    this.nextAt = at + buffer.duration
    this.voices.add(voice)
    voice.onended = () => this.voices.delete(voice)
  }

  flush() {
    for (const voice of this.voices) {
      try {
        voice.stop()
      } catch {
        /* not started yet, or already over */
      }
    }
    this.voices.clear()
    this.nextAt = 0
  }

  playing(): boolean {
    return this.voices.size > 0
  }

  /** How loud Rico is right now (0 … 1). */
  level(): number {
    if (!this.analyser || !this.voices.size) return 0
    this.analyser.getFloatTimeDomainData(this.wave)
    let sum = 0
    for (const s of this.wave) sum += s * s
    return Math.sqrt(sum / this.wave.length)
  }

  /** Rico's mouth for the 3D Rico, or null when he isn't talking (lib/speech/channel's mouthNow). */
  mouth(): MouthParams | null {
    return this.playing() ? mouthFor(this.level(), performance.now()) : null
  }

  close() {
    this.stopMic()
    this.flush()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.analyser = null
  }
}
