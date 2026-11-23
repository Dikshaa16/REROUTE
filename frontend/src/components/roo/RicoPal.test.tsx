import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { native } from '@/lib/platform'
import { getState, setState } from '@/lib/store'

const voiceChat = vi.hoisted(() => ({ on: true }))
vi.mock('@/api/queries', () => ({ useVoiceChatEnabled: () => voiceChat.on }))
const sound = vi.hoisted(() => vi.fn())
vi.mock('@/lib/roo/sounds', () => ({ ricoSound: sound }))

import { answer, BUBBLE_MS, OFFER_AFTER_MS, RicoPal } from './RicoPal'

beforeEach(() => {
  vi.clearAllMocks()
  voiceChat.on = true
  setState({ ricoRoams: true, ricoBubble: null, rooChat: false, ricoVoice: null, rooChatSay: null })
})

afterEach(() => {
  vi.useRealTimers()
  setState({ ricoBubble: null, rooChat: false, ricoVoice: null, rooChatSay: null })
  delete native.wake
  localStorage.clear()
})

function Where() {
  const at = useLocation()
  return <p data-testid="where">{`${at.pathname} ${JSON.stringify(at.state)}`}</p>
}

const inApp = (onToday: boolean) => (
  <MemoryRouter>
    <RicoPal onToday={onToday} bottom="72px" />
    <Where />
  </MemoryRouter>
)
const pal = (onToday = false) => render(inApp(onToday))

describe('Rico out and about', () => {
  it('walks along the other screens, and asks if you need him when tapped', () => {
    pal()
    fireEvent.click(screen.getByRole('button', { name: 'Rico: tap to talk' }))
    expect(sound).toHaveBeenCalledWith('giggle')
    expect(screen.getByText('Hi! Need me?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Talk' }))
    expect(getState().ricoVoice).toEqual({ from: 'tap', say: undefined })
    expect(getState().ricoBubble).toBeNull()
  })

  it('offers only the chat where Rico can’t talk out loud', () => {
    voiceChat.on = false
    pal()
    fireEvent.click(screen.getByRole('button', { name: 'Rico: tap to talk' }))
    expect(screen.queryByRole('button', { name: 'Talk' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(getState().rooChat).toBe(true)
  })

  it('steps aside on Today, and for the chat, his voice screen, or when turned off', async () => {
    const { rerender } = pal(true)
    expect(screen.queryByRole('button', { name: 'Rico: tap to talk' })).toBeNull()
    // With something to say, he comes to Today too.
    act(() => setState({ ricoBubble: { text: 'Hi, are you there? 👋', replies: [], at: Date.now() } }))
    expect(screen.getByRole('button', { name: 'Rico: tap to talk' })).toBeTruthy()
    act(() => setState({ ricoBubble: null, ricoRoams: false }))
    rerender(inApp(false))
    // He walks off (an exit animation) and is gone.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rico: tap to talk' })).toBeNull())
    act(() => setState({ ricoRoams: true, rooChat: true }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rico: tap to talk' })).toBeNull())
  })

  it('lets an unanswered bubble go after a while', () => {
    vi.useFakeTimers()
    pal()
    act(() => setState({ ricoBubble: { text: 'Hello', replies: [], at: Date.now() } }))
    expect(screen.getByText('Hello')).toBeTruthy()
    act(() => vi.advanceTimersByTime(BUBBLE_MS + 10))
    expect(getState().ricoBubble).toBeNull()
  })
})

describe('Rico offers “Hey Rico”', () => {
  const OFFER = 'Want to call me hands-free? Just say “Hey Rico”, even with Reroute closed.'
  let enabled = false
  beforeEach(() => {
    vi.useFakeTimers()
    enabled = false
    native.wake = {
      status: vi.fn(async () => ({ modelReady: false, enabled, background: false, listening: enabled, microphone: true, popUp: false, overlay: false })),
      download: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      popUp: vi.fn(),
    }
  })
  const opened = async () => {
    await act(async () => void vi.advanceTimersByTime(OFFER_AFTER_MS))
  }

  it('walks in with it in the app, a moment after Reroute opens, even on Today: “Turn it on” sets it up in Me', async () => {
    pal(true)
    expect(screen.queryByText(OFFER)).toBeNull()
    await opened()
    expect(screen.getByText(OFFER)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }))
    expect(screen.getByTestId('where').textContent).toBe('/me {"heyRico":true}')
    expect(getState().ricoBubble).toBeNull()
  })

  it('offers it once', async () => {
    const { unmount } = pal()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(getState().ricoBubble).toBeNull()
    unmount()
    pal()
    await opened()
    expect(screen.queryByText(OFFER)).toBeNull()
  })

  it('not when it’s on, nor in a browser, which has no ear for it', async () => {
    enabled = true
    const { unmount } = pal()
    await opened()
    expect(getState().ricoBubble).toBeNull()
    unmount()
    delete native.wake
    pal()
    await opened()
    expect(getState().ricoBubble).toBeNull()
  })

  it('waits for another time when Rico is busy or kept from walking about', async () => {
    setState({ ricoRoams: false })
    const { unmount } = pal()
    await opened()
    expect(getState().ricoBubble).toBeNull()
    unmount()
    setState({ ricoRoams: true })
    pal()
    await opened()
    expect(screen.getByText(OFFER)).toBeTruthy()
  })
})

describe('answering Rico’s check-in', () => {
  it('brings him up talking, starting with why he came', () => {
    answer({ label: 'Hi Rico, what’s up?', then: 'voice', say: 'Roads are busy.' }, true)
    expect(getState().ricoVoice).toEqual({ from: 'nudge', say: 'Roads are busy.' })
  })

  it('opens the chat with his words where he can’t talk out loud', () => {
    answer({ label: 'Hi Rico, what’s up?', then: 'voice', say: 'Roads are busy.' }, false)
    expect(getState().rooChat).toBe(true)
    expect(getState().rooChatSay).toBe('Roads are busy.')
  })
})
