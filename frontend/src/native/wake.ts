// "Hey Rico" in the Android app: Rico's ear on the phone itself (Vosk, through the app's own plugin,
// android/app/src/main/java/com/reroute/app/RicoWakePlugin.java). Nothing the microphone hears leaves the phone; on
// "Hey Rico" the page opens Rico talking out loud. Turned on in Me, only while Reroute is open or even when it's
// closed (then Android shows "Rico is listening" all the while, and Rico pops up as a notification).
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface WakeStatus {
  /** Rico's ear (the speech model, about 38 MB) is downloaded. */
  modelReady: boolean
  enabled: boolean
  /** Even when Reroute is closed. */
  background: boolean
  listening: boolean
  microphone: boolean
  /** Rico pops up over other apps on "Hey Rico" (wanted, and Android's "Display over other apps" allowed). */
  popUp: boolean
  /** Android lets Reroute display over other apps. */
  overlay: boolean
}

interface RicoWake {
  status(): Promise<WakeStatus>
  download(): Promise<void>
  start(options: { background: boolean }): Promise<void>
  stop(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  launchedByRico(): Promise<{ wake: boolean }>
  popUp(options: { on: boolean }): Promise<{ asked: boolean }>
  addListener(event: 'wake', listener: (e: { from: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'download', listener: (e: { percent: number }) => void): Promise<PluginListenerHandle>
}

const Wake = registerPlugin<RicoWake>('RicoWake')

export const wake = {
  status: () => Wake.status(),
  /** Rico's ear, the first time: `onProgress` gets 0 … 100. */
  async download(onProgress: (percent: number) => void) {
    const handle = await Wake.addListener('download', (e) => onProgress(e.percent))
    try {
      await Wake.download()
    } finally {
      await handle.remove()
    }
  },
  start: (background: boolean) => Wake.start({ background }),
  stop: () => Wake.stop(),
  /** Pop up over other apps; on without Android's permission, Android's page for it opens (`asked`). */
  popUp: (on: boolean) => Wake.popUp({ on }),
  /** Rico talks out loud: his ear lets go of the microphone meanwhile. */
  pause: () => Wake.pause().catch(() => {}),
  resume: () => Wake.resume().catch(() => {}),
}

/**
 * Each "Hey Rico" (heard, or tapped in Rico's notification) calls `onWake`; so does opening the app from it. Whenever
 * Reroute comes on screen with Rico not `talking` out loud, his ear listens again: a voice screen that went without
 * saying so (the app swiped away mid-conversation) can't leave him deaf.
 */
export async function startWake(onWake: () => void, talking: () => boolean) {
  const listen = () => {
    if (document.visibilityState === 'visible' && !talking()) void wake.resume()
  }
  document.addEventListener('visibilitychange', listen)
  await Wake.addListener('wake', () => onWake())
  if ((await Wake.launchedByRico()).wake) onWake()
  else listen()
}
