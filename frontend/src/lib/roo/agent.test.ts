import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ api: { post }, newKey: (prefix: string) => `${prefix}-key` }))

import { askAgent, guideHello } from './agent'

beforeEach(() => post.mockReset().mockResolvedValue({ reply: 'Hi!', reads: [] }))

describe('Rico’s agent', () => {
  it('asks as the local guide only in tourist mode', async () => {
    await askAgent('recommend places', [{ role: 'roo', text: 'Shall I recommend places?' }], 'trip-001', 'tourist')
    expect(post.mock.calls[0][1]).toEqual({ message: 'recommend places', history: [{ role: 'roo', text: 'Shall I recommend places?' }], tripId: 'trip-001', mode: 'tourist' })
    await askAgent('skip the bank', [], 'trip-001')
    expect(post.mock.calls[1][1]).toEqual({ message: 'skip the bank', history: [], tripId: 'trip-001' })
  })
})

describe('Rico as a guide', () => {
  it('asks whether to recommend places or follow yours, in the trip’s city', () => {
    expect(guideHello('Bengaluru')).toEqual({
      line: 'Ooh, Bengaluru! I’ll be your guide today 🧭 Shall I recommend places to see, eat and do, or do you have some in mind?',
      choices: ['Recommend places', 'I have places in mind'],
    })
  })

  it('asks which city first when there’s no trip yet', () => {
    expect(guideHello(undefined)).toEqual({ line: 'Ooh, an adventure! I’ll be your guide 🧭 Which city are we exploring?', choices: [] })
  })
})
