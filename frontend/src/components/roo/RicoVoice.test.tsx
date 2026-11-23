import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RooProposal } from '@/api/types'
import { native } from '@/lib/platform'
import type { LiveEvents } from '@/lib/roo/live/session'
import { getState, setState } from '@/lib/store'

const session = vi.hoisted(() => ({ stop: vi.fn(), mute: vi.fn(), sendText: vi.fn(), note: vi.fn(), level: vi.fn(() => 0) }))
const opened = vi.hoisted(() => ({ events: null as LiveEvents | null, opts: null as unknown }))
vi.mock('@/lib/roo/live', () => ({
  openVoice: vi.fn(async (opts: unknown, events: LiveEvents) => {
    opened.opts = opts
    opened.events = events
    return session
  }),
}))
const agent = vi.hoisted(() => ({ askAgent: vi.fn(), runProposal: vi.fn(), undoProposal: vi.fn() }))
vi.mock('@/lib/roo/agent', () => agent)
const sound = vi.hoisted(() => vi.fn())
vi.mock('@/lib/roo/sounds', () => ({ ricoSound: sound }))

import { addCaption, RicoVoice } from './RicoVoice'

const proposal: RooProposal = {
  proposalId: 'rp_1',
  tripId: 'trip-001',
  totalCostInr: 0,
  final: [],
  expiresAt: '2026-10-25T08:00:00Z',
  steps: [{ stepId: 's1', tool: 'skip_task', kind: 'server', label: 'Skip “Bank”', icon: 'skip', args: {}, auto: false }],
}

beforeEach(() => {
  vi.clearAllMocks()
  opened.events = null
  setState({ ricoVoice: { from: 'tap' }, rooChat: false, ricoGuide: false })
})

afterEach(() => setState({ ricoVoice: null, ricoGuide: false }))

async function open() {
  render(<RicoVoice trip={undefined} />)
  await waitFor(() => expect(opened.events).not.toBeNull())
  return opened.events!
}

describe('Rico, talking out loud', () => {
  it('pops up with a sound, and shows what he is doing', async () => {
    const events = await open()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(sound).toHaveBeenCalledWith('appear')
    expect(screen.getByText('Waking up…')).toBeTruthy()
    act(() => events.state('listening'))
    expect(screen.getByText('Listening…')).toBeTruthy()
    // The glow round him shows who's talking, as the words say.
    expect(document.querySelector('[data-aura="listening"]')).toBeTruthy()
    act(() => events.state('hearing'))
    expect(screen.getByText('Hearing you…')).toBeTruthy()
    act(() => events.state('thinking'))
    expect(screen.getByText('Thinking…')).toBeTruthy()
    expect(document.querySelector('[data-aura="thinking"]')).toBeTruthy()
    act(() => events.state('speaking'))
    expect(screen.getByText('Rico is talking')).toBeTruthy()
  })

  it('shows no chat, and captions both sides as the words come once asked', async () => {
    const events = await open()
    act(() => {
      events.caption('you', 'Hey Rico, ')
      events.caption('you', 'when do I leave?')
      events.caption('rico', 'At ten to nine!')
    })
    expect(screen.queryByText('At ten to nine!')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Captions' }))
    expect(screen.getByRole('button', { name: 'Captions' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('“Hey Rico, when do I leave?”')).toBeTruthy()
    expect(screen.getByText('At ten to nine!')).toBeTruthy()
  })

  it("puts a change from Rico's planner on a card, and runs it only on Do all", async () => {
    agent.askAgent.mockResolvedValue({ reply: 'I can skip the bank.', reads: [], proposal })
    agent.runProposal.mockResolvedValue({ proposalId: 'rp_1', state: 'done', tripId: 'trip-001', steps: [], phone: [], summary: 'Skipped the bank.', canUndo: true })
    const events = await open()
    let said = ''
    await act(async () => {
      said = await events.tool('skip the bank')
    })
    expect(said).toMatch(/I can skip the bank\..*Do all/)
    expect(agent.askAgent).toHaveBeenCalledWith('skip the bank', [], null, undefined)
    expect(screen.getByText('Skip “Bank”')).toBeTruthy()
    expect(agent.runProposal).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Do/ })))
    expect(agent.runProposal).toHaveBeenCalledWith('rp_1')
    await waitFor(() => expect(session.note).toHaveBeenCalledWith('The traveller tapped "Do all". Skipped the bank.'))
  })

  it('is the traveller’s guide out loud too, while guide mode is on', async () => {
    setState({ ricoGuide: true })
    agent.askAgent.mockResolvedValue({ reply: 'Lalbagh, Cubbon Park and the palace.', reads: [] })
    const events = await open()
    expect(opened.opts).toEqual({ tripId: null, mode: 'tourist' })
    await act(async () => void (await events.tool('recommend places')))
    expect(agent.askAgent).toHaveBeenCalledWith('recommend places', [], null, 'tourist')
  })

  it('mutes, and ends', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Mute the microphone' }))
    expect(session.mute).toHaveBeenCalledWith(true)
    expect(screen.getByText('Muted')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'End the conversation' }))
    expect(getState().ricoVoice).toBeNull()
    expect(getState().rooChat).toBe(false)
  })

  it('has the microphone to itself while on screen, and gives it back to Rico’s ear when he goes', async () => {
    const ear = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) }
    native.wake = ear as unknown as NonNullable<typeof native.wake>
    try {
      await open()
      expect(ear.pause).toHaveBeenCalledTimes(1)
      // Back on screen: his ear listened while Reroute was in the back, so it lets go again.
      document.dispatchEvent(new Event('visibilitychange'))
      expect(ear.pause).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole('button', { name: 'End the conversation' }))
      await waitFor(() => expect(ear.resume).toHaveBeenCalledOnce())
    } finally {
      delete native.wake
    }
  })

  it('says hello when called by name', async () => {
    setState({ ricoVoice: { from: 'wake' } })
    await open()
    // Unless they're already talking: then he just listens.
    await waitFor(() => expect(session.note).toHaveBeenCalledWith(expect.stringContaining('Hey Rico'), true))
  })

  it('says so kindly when he has to go', async () => {
    const events = await open()
    act(() => events.ended('failed', 'Quota used up'))
    expect(screen.getByText('Quota used up')).toBeTruthy()
    expect(screen.getByText('Not here right now')).toBeTruthy()
  })

  it('giggles when booped', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Boop Rico' }))
    expect(sound).toHaveBeenCalledWith('giggle')
  })
})

describe('captions', () => {
  it("joins a speaker's pieces, and keeps the last few lines", () => {
    let lines = addCaption([], 'you', ' Hi')
    lines = addCaption(lines, 'you', ' Rico')
    lines = addCaption(lines, 'rico', 'Hello!')
    expect(lines).toEqual([
      { who: 'you', text: 'Hi Rico' },
      { who: 'rico', text: 'Hello!' },
    ])
    for (const w of ['you', 'rico', 'you', 'rico'] as const) lines = addCaption(lines, w, 'x')
    expect(lines).toHaveLength(4)
  })
})
