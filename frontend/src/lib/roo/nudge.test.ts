import { describe, expect, it } from 'vitest'
import { nudgeBubble, nudgeWords } from './nudge'

describe('Rico checking in', () => {
  it('says why, before busy roads, with the time to leave by in the trip’s own time', () => {
    expect(nudgeWords({ reason: 'busy', label: 'Cab to the bank.', extraMin: '20', suggestLeaveBy: '2026-10-15T19:53:00+05:30' })).toBe(
      'Roads are usually busy around now, so Cab to the bank could take about 20 minutes longer. Leaving by 19:53 would be safer. Want me to move your plan?',
    )
  })

  it('offers to re-plan when the traveller is behind', () => {
    expect(nudgeWords({ reason: 'behind', label: 'Metro to the office', behindMin: 12 })).toBe("You're about 12 minutes behind for Metro to the office. Want me to re-plan the rest of your day?")
    expect(nudgeWords({ reason: 'behind' })).toBe("You're running behind for your next leg. Want me to re-plan the rest of your day?")
  })

  it('copes with missing details', () => {
    expect(nudgeWords({ reason: 'busy' })).toBe('Roads are usually busy around now, so your next leg could take a bit longer. Leaving a little earlier would be safer. Want me to move your plan?')
  })

  it('pops up with “Hi, are you there?”, and the answer has him explain', () => {
    const bubble = nudgeBubble({ reason: 'behind', label: 'Bus', behindMin: 6 }, 5)
    expect(bubble).toEqual({
      text: 'Hi, are you there? 👋',
      replies: [{ label: 'Hi Rico, what’s up?', then: 'voice', say: "You're about 6 minutes behind for Bus. Want me to re-plan the rest of your day?" }],
      at: 5,
    })
  })
})
