import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { native } from '@/lib/platform'
import { HeyRicoSettings } from './HeyRicoSettings'

const toast = vi.hoisted(() => vi.fn())
vi.mock('@/lib/store', async (actual) => ({ ...(await actual<typeof import('@/lib/store')>()), showToast: toast }))

let state = { modelReady: false, enabled: false, background: false, listening: false, microphone: false, popUp: false, overlay: false }
const wake = {
  status: vi.fn(async () => ({ ...state })),
  download: vi.fn(async (onProgress: (p: number) => void) => {
    onProgress(45)
    state.modelReady = true
  }),
  start: vi.fn(async (background: boolean) => {
    state = { ...state, enabled: true, background, listening: true }
  }),
  stop: vi.fn(async () => {
    state = { ...state, enabled: false, listening: false }
  }),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  // Android's "Display over other apps" page opens the first time; allowed there, Rico pops up from then on.
  popUp: vi.fn(async (on: boolean) => {
    const asked = on && !state.overlay
    state = { ...state, popUp: on && state.overlay }
    return { asked }
  }),
}

beforeEach(() => {
  vi.clearAllMocks()
  state = { modelReady: false, enabled: false, background: false, listening: false, microphone: false, popUp: false, overlay: false }
  native.wake = wake
})

afterEach(() => {
  delete native.wake
})

/** Me, opened as usual or from Rico's offer on Today (`state`). */
const settings = (state?: unknown) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/me', state }]}>
      <HeyRicoSettings />
    </MemoryRouter>,
  )

describe('“Hey Rico” in Me', () => {
  it('is only in the app, where there is an ear for it', () => {
    delete native.wake
    const { container } = settings()
    expect(container.textContent).toBe('')
  })

  it('downloads Rico’s ear the first time, then listens while Reroute is open', async () => {
    settings()
    const on = await screen.findByRole('switch', { name: /Hey Rico/ })
    expect(on.getAttribute('aria-checked')).toBe('false')
    await act(async () => fireEvent.click(on))
    expect(wake.download).toHaveBeenCalledOnce()
    expect(wake.start).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.getByRole('switch', { name: /Hey Rico/ }).getAttribute('aria-checked')).toBe('true'))
    expect(toast).toHaveBeenCalledWith({ title: 'Say “Hey Rico” while Reroute is open.' })
  })

  it('listens even with Reroute closed only when asked, and turns off', async () => {
    state = { ...state, modelReady: true, enabled: true }
    settings()
    const closed = await screen.findByRole('switch', { name: /Even when Reroute is closed/ })
    await act(async () => fireEvent.click(closed))
    expect(wake.download).not.toHaveBeenCalled()
    expect(wake.start).toHaveBeenCalledWith(true)
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: /Hey Rico/ })))
    expect(wake.stop).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('switch', { name: /Even when Reroute is closed/ })).toBeNull())
  })

  it('pops Rico up over other apps once Android allows it, asking there the first time', async () => {
    state = { ...state, modelReady: true, enabled: true, background: true }
    settings()
    const pop = await screen.findByRole('switch', { name: /Pop up over other apps/ })
    expect(pop.getAttribute('aria-checked')).toBe('false')
    await act(async () => fireEvent.click(pop))
    expect(wake.popUp).toHaveBeenCalledWith(true)
    expect(toast).toHaveBeenCalledWith({ title: 'Allow “Display over other apps” for Reroute, then come back.' })
    // Allowed on Android's page; back in Reroute, the switch shows it.
    state = { ...state, overlay: true, popUp: true }
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(screen.getByRole('switch', { name: /Pop up over other apps/ }).getAttribute('aria-checked')).toBe('true'))
  })

  it('offers the pop-up only with Reroute closed', async () => {
    state = { ...state, modelReady: true, enabled: true }
    settings()
    await screen.findByRole('switch', { name: /Even when Reroute is closed/ })
    expect(screen.queryByRole('switch', { name: /Pop up over other apps/ })).toBeNull()
  })

  it('says what went wrong, such as no microphone', async () => {
    state = { ...state, modelReady: true }
    wake.start.mockRejectedValueOnce(new Error('Rico needs the microphone to hear “Hey Rico”.'))
    settings()
    const on = await screen.findByRole('switch', { name: /Hey Rico/ })
    await act(async () => fireEvent.click(on))
    expect(toast).toHaveBeenCalledWith({ title: 'Rico needs the microphone to hear “Hey Rico”.' })
  })

  it('sets it all up from Rico’s offer: his ear, even with Reroute closed, then popping up', async () => {
    settings({ heyRico: true })
    await waitFor(() => expect(wake.popUp).toHaveBeenCalledWith(true))
    expect(wake.download).toHaveBeenCalledOnce()
    expect(wake.start).toHaveBeenCalledWith(true)
    expect(toast).toHaveBeenCalledWith({ title: 'Allow “Display over other apps” for Reroute, then come back.' })
    // Allowed on Android's page, and back in Reroute.
    state = { ...state, overlay: true, popUp: true }
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'All set! Say “Hey Rico” any time, even with Reroute closed.' }))
    expect(screen.getByRole('switch', { name: /Pop up over other apps/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('says it’s all set at once when Android already lets Reroute pop up', async () => {
    state = { ...state, overlay: true }
    settings({ heyRico: true })
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'All set! Say “Hey Rico” any time, even with Reroute closed.' }))
    expect(toast).toHaveBeenCalledOnce()
    expect(screen.getByRole('switch', { name: /Pop up over other apps/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('says when Rico will come as a notification instead', async () => {
    settings({ heyRico: true })
    await waitFor(() => expect(wake.popUp).toHaveBeenCalledWith(true))
    // Not allowed on Android's page.
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Rico comes as a notification you tap instead. Let him pop up here any time.' }))
  })
})
