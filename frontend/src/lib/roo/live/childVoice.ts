// Rico's live voice as a child's, like Ana, the voice his alerts use. Google's live voices are all grown-ups, so the
// app raises the one Rico talks with, at its own speed: higher, and smaller too (the whole voice, as a small body
// sounds). Chunk by chunk as it comes, in two steps: the sound is read faster, which raises it but hurries it, then
// stretched back to its length by WSOLA, which repeats bits of it where the waves line up, so the words keep their
// pace and the pitch stays raised.

/** The low-pass before reading faster: higher sounds would fold back as a hiss. */
const TAPS = 31

/** Raises a voice by `semitones` at the same speed, chunk by chunk. */
export class ChildVoice {
  readonly ratio: number
  readonly rate: number
  private readonly hop: number
  private readonly frame: number
  private readonly seek: number
  private readonly window: Float32Array
  private readonly lowpass: Float32Array
  /** The last few samples in, for the low-pass. */
  private history: Float32Array = new Float32Array(TAPS - 1)
  /** Low-passed sound not yet read, and where in it the next sample is read. */
  private filtered: Float32Array = new Float32Array(0)
  private at = 0
  /** Sound read faster, waiting to be stretched; `base` is where it starts, counted from the first sample. */
  private buf: Float32Array = new Float32Array(0)
  private base = 0
  /** Where the next piece would come from, if nothing had to line up; and where the last one came from. */
  private ideal = 0
  private last = -1
  /** The second half of the last piece, faded out, for the next piece to fade in over. */
  private tail: Float32Array
  /** Sound has come in since the last fresh start. */
  private fed = false

  constructor(semitones: number, rate: number) {
    this.ratio = 2 ** (semitones / 12)
    this.rate = rate
    // Pieces of 24 ms, half overlapping, lined up within 6 ms either way: a whole wave of any voice above 85 Hz.
    this.hop = Math.round(rate * 0.012)
    this.frame = this.hop * 2
    this.seek = Math.round(rate * 0.006)
    this.window = new Float32Array(this.frame)
    for (let i = 0; i < this.frame; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.frame)
    this.tail = new Float32Array(this.hop)
    this.lowpass = lowpass(Math.min(0.5, 0.45 / this.ratio))
  }

  /** The next chunk of the voice in; out, as much of it raised as is ready (a few hundredths of a second are held
   *  back, to line up the next piece). */
  push(samples: Float32Array): Float32Array {
    if (this.ratio === 1) return samples
    if (samples.length) this.fed = true
    return this.stretch(this.readFaster(this.filter(samples)))
  }

  /** The end of a turn: what's still held back, played out, and a fresh start for the next. */
  drain(): Float32Array {
    if (this.ratio === 1 || !this.fed) return new Float32Array(0)
    const out = this.push(new Float32Array(Math.ceil((this.frame + this.seek + TAPS) * this.ratio) + 2))
    this.reset()
    return out
  }

  /** Stops at once (the traveller talked over Rico): what's held back is dropped. */
  reset() {
    this.history = new Float32Array(TAPS - 1)
    this.filtered = new Float32Array(0)
    this.at = 0
    this.buf = new Float32Array(0)
    this.base = 0
    this.ideal = 0
    this.last = -1
    this.tail = new Float32Array(this.hop)
    this.fed = false
  }

  private filter(samples: Float32Array): Float32Array {
    const all = join(this.history, samples)
    const out = new Float32Array(samples.length)
    for (let i = 0; i < out.length; i++) {
      let sum = 0
      for (let j = 0; j < TAPS; j++) sum += this.lowpass[j] * all[i + j]
      out[i] = sum
    }
    this.history = all.slice(all.length - (TAPS - 1))
    return out
  }

  /** Read faster, by straight lines between samples: higher, and quicker. */
  private readFaster(samples: Float32Array): Float32Array {
    const src = join(this.filtered, samples)
    const out = new Float32Array(Math.max(0, Math.ceil((src.length - 1 - this.at) / this.ratio)))
    let n = 0
    while (this.at + 1 < src.length) {
      const j = Math.floor(this.at)
      out[n++] = src[j] + (src[j + 1] - src[j]) * (this.at - j)
      this.at += this.ratio
    }
    const used = Math.min(Math.floor(this.at), src.length)
    this.filtered = src.slice(used)
    this.at -= used
    return out.subarray(0, n)
  }

  /** Back to its length: overlapping pieces, each taken a little later than the last, where it lines up best with
   *  how the last one went on. */
  private stretch(samples: Float32Array): Float32Array {
    this.buf = join(this.buf, samples)
    const end = this.base + this.buf.length
    const step = this.hop / this.ratio
    const pieces: Float32Array[] = []
    while (Math.round(this.ideal) + this.seek + this.frame <= end) {
      const pos = this.last < 0 ? Math.round(this.ideal) : this.lineUp(Math.round(this.ideal))
      const out = new Float32Array(this.hop)
      for (let i = 0; i < this.hop; i++) out[i] = this.tail[i] + this.buf[pos - this.base + i] * this.window[i]
      const tail = new Float32Array(this.hop)
      for (let i = 0; i < this.hop; i++) tail[i] = this.buf[pos - this.base + this.hop + i] * this.window[this.hop + i]
      this.tail = tail
      pieces.push(out)
      this.last = pos
      this.ideal += step
    }
    const keep = Math.max(this.base, Math.min(Math.round(this.ideal) - this.seek, this.last + this.hop))
    this.buf = this.buf.slice(keep - this.base)
    this.base = keep
    return concat(pieces)
  }

  /** Where, within `seek` of `around`, the sound most looks like how the last piece went on. */
  private lineUp(around: number): number {
    const template = this.last + this.hop - this.base
    const from = Math.max(this.base, around - this.seek) - this.base
    const to = around + this.seek - this.base
    let best = around - this.base
    let bestScore = -Infinity
    for (let c = from; c <= to; c++) {
      let dot = 0
      let energy = 1e-9
      for (let i = 0; i < this.hop; i += 2) {
        const x = this.buf[c + i]
        dot += x * this.buf[template + i]
        energy += x * x
      }
      const score = dot / Math.sqrt(energy)
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    return best + this.base
  }
}

/** A windowed-sinc low-pass, cutting off at `cutoff` (a fraction of the sample rate). */
function lowpass(cutoff: number): Float32Array {
  const h = new Float32Array(TAPS)
  const mid = (TAPS - 1) / 2
  let sum = 0
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1))
    h[i] = sinc * blackman
    sum += h[i]
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum
  return h
}

function join(a: Float32Array, b: Float32Array): Float32Array {
  if (!a.length) return b
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
