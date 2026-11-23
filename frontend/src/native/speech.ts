// Rico's ears and the phone's own voice in the Android app. The web view has neither speech recognition
// nor speechSynthesis, so Android's recognizer and text-to-speech stand in, behind the same calls as the web
// (lib/voice.ts listenOnce, lib/speech/phoneVoice.ts phoneSay) and with the same messages.
import { QueueStrategy, TextToSpeech } from '@capacitor-community/text-to-speech'
import type { PluginListenerHandle } from '@capacitor/core'
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition'
import { phoneEstimateMs, type PhoneSpeech } from '@/lib/speech/phoneVoice'
import type { AlertPrefs } from '@/lib/store'
import { VoiceError } from '@/lib/voice'

// ---------- listening ----------

function heardError(err: unknown): VoiceError {
  const text = err instanceof Error ? err.message : String(err)
  if (/permission|not allowed|denied/i.test(text)) return new VoiceError('The microphone is off for Reroute. Allow it in Android settings to talk to me.')
  if (/no match|no speech|timeout|didn.t/i.test(text)) return new VoiceError('I didn’t hear anything. Tap me and try again.')
  if (/network|server/i.test(text)) return new VoiceError('Listening needs a connection. Tap the buttons instead.')
  return new VoiceError('I couldn’t listen just now. Tap the buttons instead.')
}

/** One sentence in Indian English. Gives up after `ms`; `signal` stops listening at once and the promise never settles. */
export async function listenOnce({ ms = 8000, signal }: { ms?: number; signal?: AbortSignal } = {}): Promise<string> {
  const perm = await SpeechRecognition.requestPermissions()
  if (perm.speechRecognition !== 'granted') throw new VoiceError('The microphone is off for Reroute. Allow it in Android settings to talk to me.')
  if (!(await SpeechRecognition.available()).available) throw new VoiceError('This phone can’t listen. Tap the buttons instead.')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const stop = () => void SpeechRecognition.stop().catch(() => {})
    const timer = setTimeout(() => {
      stop()
      finish(() => reject(new VoiceError('I didn’t hear anything. Tap me and try again.')))
    }, ms)
    signal?.addEventListener(
      'abort',
      () => {
        stop()
        finish(() => {})
      },
      { once: true },
    )
    SpeechRecognition.start({ language: 'en-IN', maxResults: 1, partialResults: false, popup: false }).then(
      (r) =>
        finish(() => {
          const heard = r.matches?.[0]?.trim() ?? ''
          if (heard) resolve(heard)
          else reject(new VoiceError('I didn’t catch that. Tap me and try again.'))
        }),
      (err: unknown) => finish(() => reject(heardError(err))),
    )
  })
}

// ---------- the phone's voice ----------

/** The longest a line may hold the next one back, whatever the phone does (as on the web). */
const LIMIT_MS = 15_000

let language: Promise<string> | null = null
/** Indian English where the phone has it, like the web; otherwise any English voice. */
function voiceLanguage(): Promise<string> {
  language ??= TextToSpeech.isLanguageSupported({ lang: 'en-IN' }).then(
    (r) => (r.supported ? 'en-IN' : 'en-US'),
    () => 'en-US',
  )
  return language
}

export function phoneSay(text: string, prefs: Pick<AlertPrefs, 'voiceRate' | 'volume'>): PhoneSpeech {
  let t0 = 0
  let over = false
  let markStarted: (ok: boolean) => void = () => {}
  const started = new Promise<boolean>((resolve) => {
    markStarted = resolve
  })
  let finish = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  // The first spoken word starts the clock the mouth follows; an engine that never reports words still
  // counts as speaking a moment after it took the line.
  const begin = () => {
    if (t0 || over) return
    t0 = performance.now()
    markStarted(true)
  }
  let words: PluginListenerHandle | null = null
  const fallback = setTimeout(begin, 300)
  const limit = setTimeout(() => end(), LIMIT_MS)
  function end() {
    if (over) return
    over = true
    clearTimeout(fallback)
    clearTimeout(limit)
    if (!t0) markStarted(false)
    void words?.remove()
    finish()
  }
  void TextToSpeech.addListener('onRangeStart', begin).then((h) => {
    if (over) void h.remove()
    else words = h
  })
  const rate = prefs.voiceRate === 'slow' ? 0.85 : prefs.voiceRate === 'fast' ? 1.15 : 1
  void voiceLanguage()
    .then((lang) => TextToSpeech.speak({ text, lang, rate, volume: prefs.volume, queueStrategy: QueueStrategy.Flush }))
    .then(
      () => {
        begin()
        end()
      },
      () => end(),
    )
  return {
    started,
    done,
    elapsed: () => (t0 ? performance.now() - t0 : 0),
    cancel: () => {
      void TextToSpeech.stop().catch(() => {})
      end()
    },
    estimateMs: phoneEstimateMs(text, prefs.voiceRate),
  }
}
