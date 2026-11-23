// Opening a conversation with Rico out loud: the pass from the server (POST /v1/roo/live), the socket to Google
// with it, the microphone and speaker, and Rico's mouth following his voice wherever he's drawn.

import { api, newKey } from '@/api/client'
import type { RooLive } from '@/api/types'
import { setMouthSource } from '@/lib/speech/channel'
import { WebLiveAudio } from './audio'
import { LiveConversation, type LiveEvents, type LiveState } from './session'

export type { LiveState }

export interface VoiceSession {
  stop(): void
  mute(on: boolean): void
  sendText(text: string): void
  /** Tells Rico what just happened in the app (a card ran), for him to say it; with `unlessSpoken`, only if the
   *  traveller hasn't started talking (a hello). */
  note(text: string, unlessSpoken?: boolean): void
  /** How loud Rico is right now (0 … 1), for the glow round him. */
  level(): number
}

export async function openVoice(opts: { tripId: string | null; mode?: 'tourist' }, events: LiveEvents): Promise<VoiceSession> {
  const pass = await api.post<RooLive>('/v1/roo/live', { tripId: opts.tripId, mode: opts.mode ?? null }, { idempotencyKey: newKey('roo-live') })
  const audio = new WebLiveAudio()
  // The pass is short-lived and good for this one session only; it rides in the address, as Google asks.
  const socket = new WebSocket(`${pass.url}?access_token=${encodeURIComponent(pass.token)}`)
  socket.binaryType = 'arraybuffer'
  const conversation = new LiveConversation(
    socket,
    audio,
    {
      ...events,
      ended: (reason, message) => {
        setMouthSource(null)
        events.ended(reason, message)
      },
    },
    pass.model.replace(/^models\//, ''),
    undefined,
    // Google's voice raised to a child's, like Ana's.
    pass.pitch ?? 0,
  )
  // The microphone at once: what's said while Rico wakes up is kept for him.
  conversation.listen()
  socket.onopen = () => conversation.opened()
  socket.onmessage = (e: MessageEvent<string | ArrayBuffer>) => void conversation.received(e.data)
  socket.onclose = (e) => conversation.closed(e.code, e.reason)
  setMouthSource(() => audio.mouth())
  return {
    stop: () => conversation.stop(),
    mute: (on) => conversation.mute(on),
    sendText: (text) => conversation.sendText(text),
    note: (text, unlessSpoken) => conversation.note(text, unlessSpoken),
    level: () => audio.level(),
  }
}
