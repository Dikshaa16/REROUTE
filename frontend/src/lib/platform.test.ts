import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestGoogleCode } from './google'
import { canNotify, notify } from './live'
import { isNative, native, settingsName, webOrigin } from './platform'
import { phoneSay } from './speech/phoneVoice'
import { shareText } from './tellLate'
import { listenOnce, voiceSupported } from './voice'

const win = window as unknown as { Capacitor?: unknown }

afterEach(() => {
  delete win.Capacitor
  for (const k of Object.keys(native)) delete native[k as keyof typeof native]
  vi.unstubAllGlobals()
})

describe('the platform', () => {
  it('is a browser unless Capacitor says it is the app', () => {
    expect(isNative()).toBe(false)
    win.Capacitor = { isNativePlatform: () => false }
    expect(isNative()).toBe(false)
    win.Capacitor = { isNativePlatform: () => true }
    expect(isNative()).toBe(true)
  })

  it("points links that leave the phone at the web app's host, never the app's own localhost", () => {
    expect(webOrigin('')).toBe(location.origin)
    expect(webOrigin('https://reroute.example')).toBe(location.origin)
    win.Capacitor = { isNativePlatform: () => true }
    expect(webOrigin('https://10.0.2.2')).toBe('https://10.0.2.2')
    expect(webOrigin('https://reroute.example/')).toBe('https://reroute.example')
  })

  it("names the place a permission is turned back on", () => {
    expect(settingsName()).toBe('your browser settings')
    win.Capacitor = { isNativePlatform: () => true }
    expect(settingsName()).toBe('Android settings')
  })
})

describe('the web code hands over to the app only where a hook is filled in', () => {
  it('Google: the code comes from Android sign-in', async () => {
    native.googleCode = vi.fn(async () => 'code-from-android')
    await expect(requestGoogleCode('openid email profile https://www.googleapis.com/auth/calendar.readonly')).resolves.toBe('code-from-android')
    expect(native.googleCode).toHaveBeenCalledWith('openid email profile https://www.googleapis.com/auth/calendar.readonly')
  })

  it('listening: Android recognizes the sentence', async () => {
    expect(voiceSupported()).toBe(false)
    native.listenOnce = vi.fn(async () => 'running late by ten minutes')
    expect(voiceSupported()).toBe(true)
    await expect(listenOnce({ ms: 5000 })).resolves.toBe('running late by ten minutes')
    expect(native.listenOnce).toHaveBeenCalledWith({ ms: 5000, signal: undefined })
  })

  it("the phone's voice: Android speaks the line", () => {
    const speech = { started: Promise.resolve(true), done: Promise.resolve(), elapsed: () => 0, cancel: () => {}, estimateMs: 900 }
    native.phoneSay = vi.fn(() => speech)
    expect(phoneSay('Time to leave.', { voiceRate: 'normal', volume: 1 })).toBe(speech)
  })

  it("sharing: Android's share sheet, and the clipboard only when it fails", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    native.shareText = vi.fn(async () => 'shared' as const)
    await expect(shareText('Running 10 min late')).resolves.toBe('shared')
    native.shareText = vi.fn(async () => 'cancelled' as const)
    await expect(shareText('Running 10 min late')).resolves.toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
    native.shareText = vi.fn(async () => 'failed' as const)
    await expect(shareText('Running 10 min late')).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith('Running 10 min late')
  })

  it('notifications: Android shows them, with its own permission', async () => {
    expect(canNotify()).toBe(false)
    const show = vi.fn(async () => {})
    native.notifications = { granted: () => true, request: async () => true, show }
    expect(canNotify()).toBe(true)
    await notify('Reroute', { body: 'Leave now. Cab to the bank.', tag: 'leave-2' })
    expect(show).toHaveBeenCalledWith('Reroute', { body: 'Leave now. Cab to the bank.', tag: 'leave-2', silent: false })
  })
})
