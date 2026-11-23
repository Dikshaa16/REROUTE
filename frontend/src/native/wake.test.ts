import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners = vi.hoisted(() => ({} as Record<string, (e: unknown) => void>))
const plugin = vi.hoisted(() => ({
  status: vi.fn(),
  download: vi.fn(async () => {
    listeners.download?.({ percent: 50 })
  }),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  launchedByRico: vi.fn(async () => ({ wake: false })),
  popUp: vi.fn(async () => ({ asked: true })),
  addListener: vi.fn(async (event: string, l: (e: unknown) => void) => {
    listeners[event] = l
    return { remove: async () => void delete listeners[event] }
  }),
}))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => plugin }))

import { startWake, wake } from './wake'

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(listeners)) delete listeners[k]
})

describe('“Hey Rico” in the app', () => {
  it('reports download progress, then stops listening for it', async () => {
    const seen: number[] = []
    await wake.download((p) => seen.push(p))
    expect(seen).toEqual([50])
    expect(listeners.download).toBeUndefined()
  })

  it('starts while open or even when closed', async () => {
    await wake.start(true)
    expect(plugin.start).toHaveBeenCalledWith({ background: true })
  })

  it('turns the pop-up over other apps on, saying when Android asked first', async () => {
    expect(await wake.popUp(true)).toEqual({ asked: true })
    expect(plugin.popUp).toHaveBeenCalledWith({ on: true })
  })

  it('opens Rico on each “Hey Rico”, and when the app was opened from his notification', async () => {
    const onWake = vi.fn()
    plugin.launchedByRico.mockResolvedValueOnce({ wake: true })
    // (Talking all along, so this one never asks his ear to listen again in the tests after it.)
    await startWake(onWake, () => true)
    expect(onWake).toHaveBeenCalledTimes(1)
    listeners.wake({ from: 'voice' })
    expect(onWake).toHaveBeenCalledTimes(2)
  })

  it('listens again whenever Reroute comes on screen with Rico not talking: a voice screen gone with the app can’t leave him deaf', async () => {
    let talking = false
    await startWake(vi.fn(), () => talking)
    // Opened as usual.
    expect(plugin.resume).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(plugin.resume).toHaveBeenCalledTimes(2)
    // Back on screen in the middle of a conversation: his voice screen keeps the microphone.
    talking = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(plugin.resume).toHaveBeenCalledTimes(2)
  })

  it('never fails the page when pausing for Rico’s voice', async () => {
    plugin.pause.mockRejectedValueOnce(new Error('not running'))
    await expect(wake.pause()).resolves.toBeUndefined()
  })
})
