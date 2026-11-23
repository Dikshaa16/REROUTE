import { describe, expect, it } from 'vitest'
import { floatToPcm16, fromBase64, loudness, MIC_RATE, micChunk, pcm16ToFloat, resample, toBase64 } from './pcm'

describe('sound as numbers for Google', () => {
  it('turns samples into 16-bit PCM, clipping anything too loud', () => {
    expect([...floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -3]))]).toEqual([0, 32767, -32768, 16384, 32767, -32768])
  })

  it('reads little-endian 16-bit PCM back into samples', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f])
    const out = pcm16ToFloat(bytes)
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(-0.5)
    expect(out[2]).toBeCloseTo(1, 3)
    // An odd last byte is half a sample: left out.
    expect(pcm16ToFloat(new Uint8Array([0, 0, 1])).length).toBe(1)
  })

  it('changes the rate by straight lines between neighbours', () => {
    const up = resample(new Float32Array([0, 1]), 1, 2)
    expect([...up]).toEqual([0, 0.5, 1, 1])
    expect(resample(new Float32Array(48000), 48000, MIC_RATE).length).toBe(16000)
    const same = new Float32Array([1, 2])
    expect(resample(same, 16000, 16000)).toBe(same)
  })

  it('round-trips base64, even a whole second of audio', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256)
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('measures how loud a stretch is', () => {
    expect(loudness(new Float32Array(0))).toBe(0)
    expect(loudness(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
  })

  it('makes a microphone chunk at 16 kHz from whatever rate the phone records at', () => {
    // A tenth of a second at 48 kHz: 1,600 samples at 16 kHz, two bytes each.
    expect(fromBase64(micChunk(new Float32Array(4800), 48000)).length).toBe(3200)
  })
})
