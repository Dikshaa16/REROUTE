// The microphone for talking with Rico out loud (src/lib/roo/live/audio.ts): it gathers about a tenth of a
// second of samples at a time and hands them to the page, which sends them to Google. A file of the site's own,
// so the page's security policy lets it load.
class RicoMic extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(Math.round(sampleRate / 10))
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let from = 0
    while (from < channel.length) {
      const take = Math.min(channel.length - from, this.buffer.length - this.filled)
      this.buffer.set(channel.subarray(from, from + take), this.filled)
      this.filled += take
      from += take
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0))
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('rico-mic', RicoMic)
