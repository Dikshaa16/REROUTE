import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/queries', () => ({ usePlaceSearch: () => ({ data: undefined, isFetching: false }) }))

// The thread scrolls to its last line; jsdom doesn't scroll.
beforeAll(() => {
  Element.prototype.scrollTo ??= () => {}
})

import { ChatThread, type ThreadProps } from './ChatThread'
import { swellOf } from './RicoAura'

function thread(more: Partial<ThreadProps> = {}) {
  const props: ThreadProps = {
    msgs: [],
    thinking: false,
    listening: false,
    expect: { kind: 'free' },
    suggestions: [],
    inFlow: false,
    busy: false,
    onSend: vi.fn(),
    onPick: vi.fn(),
    onPlace: vi.fn(),
    onDate: vi.fn(),
    onTime: vi.fn(),
    onLeave: vi.fn(),
    onRun: vi.fn(),
    onDecline: vi.fn(),
    onListen: vi.fn(),
    onLink: vi.fn(),
    ...more,
  }
  render(<ChatThread {...props} />)
  return props
}

describe('talking to Rico out loud from the chat', () => {
  it('puts the voice button where Send is while the box is empty, as voice assistants do', () => {
    const onVoice = vi.fn()
    const props = thread({ onVoice })
    fireEvent.click(screen.getByRole('button', { name: 'Talk to Rico out loud' }))
    expect(onVoice).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    // Typing turns it back into Send.
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Rico' }), { target: { value: 'what’s next?' } })
    expect(screen.queryByRole('button', { name: 'Talk to Rico out loud' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(props.onSend).toHaveBeenCalledWith('what’s next?')
  })

  it('keeps Send where the server can’t talk out loud', () => {
    thread()
    expect(screen.queryByRole('button', { name: 'Talk to Rico out loud' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })
})

describe('the glow round Rico', () => {
  it('swells with the voice: nothing at silence, fully at a loud voice, never past it', () => {
    expect(swellOf(0)).toBe(0)
    expect(swellOf(0.05)).toBeCloseTo(0.5)
    expect(swellOf(0.5)).toBe(1)
    expect(swellOf(-1)).toBe(0)
  })
})
