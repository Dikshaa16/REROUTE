import { X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useVoiceChatEnabled } from '@/api/queries'
import { RooAvatar } from '@/components/roo3d/RooAvatar'
import { native } from '@/lib/platform'
import { ricoSound } from '@/lib/roo/sounds'
import { getState, setState, useStore, type RicoBubble } from '@/lib/store'
import type { Mood } from './mood'

/** How long a bubble stays when nobody answers it. */
export const BUBBLE_MS = 15_000
/** Left alone this long, Rico naps. */
const NAP_AFTER_MS = 90_000
/** Rico offers "Hey Rico" this long after Reroute opens. */
export const OFFER_AFTER_MS = 6000
const OFFERED_KEY = 'reroute.rico.heyRicoOffered'

/** Answering Rico's bubble: he comes up full screen, talking (or in the chat, where he can't talk out loud). */
export function answer(reply: RicoBubble['replies'][number], voiceChat: boolean) {
  if (reply.then === 'voice' && voiceChat) setState({ ricoBubble: null, ricoVoice: { from: reply.say ? 'nudge' : 'tap', say: reply.say } })
  else setState({ ricoBubble: null, rooChat: true, rooChatSay: reply.say ?? null })
}

/**
 * In the Android app with "Hey Rico" off, Rico walks in a moment after Reroute opens and offers it, once: off until
 * it's turned on, nobody finds it in Me by chance. Busy (the chat, his voice screen, another bubble) or told not to
 * walk about, he offers it another time.
 */
function useHeyRicoOffer() {
  useEffect(() => {
    const wake = native.wake
    if (!wake) return
    try {
      if (localStorage.getItem(OFFERED_KEY) === '1') return
    } catch {
      return
    }
    const timer = window.setTimeout(() => {
      const s = getState()
      if (!s.ricoRoams || s.ricoBubble || s.rooChat || s.ricoVoice) return
      wake.status().then(
        (status) => {
          if (status.enabled || getState().ricoBubble) return
          try {
            localStorage.setItem(OFFERED_KEY, '1')
          } catch {
            // Private storage: he may offer it again.
          }
          setState({ ricoBubble: { text: 'Want to call me hands-free? Just say “Hey Rico”, even with Reroute closed.', replies: [{ label: 'Turn it on', then: 'hey-rico' }], at: Date.now() } })
        },
        () => {},
      )
    }, OFFER_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [])
}

/**
 * Rico out and about: a small Rico along the bottom of every screen, above the tab bar. Now and then he strolls
 * somewhere else, sits or looks around, and naps when nobody has bothered him for a while; when he has something
 * to say (a check-in before busy roads), a speech bubble pops up with answers to tap. Tap him and he giggles and
 * asks if you need him. He stays out of the way: only he and his bubble take taps, he steps aside while the chat
 * or his voice screen is open, and with reduced motion he sits still in his corner. On Today he rides the Now line
 * instead, so this Rico comes there only with something to say.
 */
export function RicoPal({ onToday, bottom }: { onToday: boolean; bottom: string }) {
  const roams = useStore((s) => s.ricoRoams)
  const bubble = useStore((s) => s.ricoBubble)
  const chat = useStore((s) => s.rooChat)
  const voice = useStore((s) => s.ricoVoice)
  const voiceChat = useVoiceChatEnabled()
  const reduce = !!useReducedMotion()
  const [x, setX] = useState(0.82)
  const [walkFor, setWalkFor] = useState(0)
  const [facing, setFacing] = useState<1 | -1>(-1)
  const [walking, setWalking] = useState(false)
  const [mood, setMood] = useState<Mood>('wave')
  const [hop, setHop] = useState(0)
  const touched = useRef(Date.now())
  const at = useRef(x)
  at.current = x
  const navigate = useNavigate()
  useHeyRicoOffer()

  const shown = roams && !chat && !voice && (!onToday || !!bubble)

  const reply = (r: RicoBubble['replies'][number]) => {
    if (r.then !== 'hey-rico') return answer(r, voiceChat)
    // Set up in Me, where it's explained and can be turned off again (HeyRicoSettings).
    setState({ ricoBubble: null })
    void navigate('/me', { state: { heyRico: true } })
  }

  // Wandering: a stroll to somewhere else along the bottom, a sit or a look around; a nap when left alone.
  useEffect(() => {
    if (!shown || reduce) return
    let timer = 0
    const next = () => {
      if (Date.now() - touched.current > NAP_AFTER_MS && !getState().ricoBubble) setMood('sleeping')
      else {
        const r = Math.random()
        const to = 0.06 + Math.random() * 0.82
        if (r < 0.5 && Math.abs(to - at.current) > 0.08) {
          setFacing(to > at.current ? 1 : -1)
          setWalkFor(0.8 + Math.abs(to - at.current) * 3.5)
          setWalking(true)
          setX(to)
        } else setMood(r < 0.75 ? 'idle' : 'happy')
      }
      timer = window.setTimeout(next, 7000 + Math.random() * 8000)
    }
    timer = window.setTimeout(next, 4000)
    return () => window.clearTimeout(timer)
  }, [shown, reduce])

  // A bubble wakes him up; nobody answering, it goes after a while.
  useEffect(() => {
    if (!bubble) return
    setMood('wave')
    touched.current = Date.now()
    const timer = window.setTimeout(
      () => {
        if (getState().ricoBubble === bubble) setState({ ricoBubble: null })
      },
      Math.max(0, BUBBLE_MS - (Date.now() - bubble.at)),
    )
    return () => window.clearTimeout(timer)
  }, [bubble])

  const tap = () => {
    touched.current = Date.now()
    setHop((h) => h + 1)
    setMood('celebrate')
    ricoSound('giggle')
    if (!getState().ricoBubble) {
      const replies: RicoBubble['replies'] = voiceChat ? [{ label: 'Talk', then: 'voice' }, { label: 'Chat', then: 'chat' }] : [{ label: 'Chat', then: 'chat' }]
      setState({ ricoBubble: { text: 'Hi! Need me?', replies, at: Date.now() } })
    }
  }

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key="rico"
          className="pointer-events-none fixed inset-x-0 z-40 mx-auto h-0 max-w-[560px]"
          style={{ bottom }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 48 }}
          animate={{ opacity: 1, y: 0, transition: reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 260, damping: 18 } }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 48, transition: { duration: 0.2 } }}
        >
          <motion.div
            className="absolute bottom-0"
            style={{ x: '-50%' }}
            initial={false}
            animate={{ left: `${x * 100}%` }}
            transition={reduce ? { duration: 0 } : { duration: walkFor, ease: 'easeInOut' }}
            onAnimationComplete={() => setWalking(false)}
          >
            <AnimatePresence>
              {bubble && (
                <motion.div
                  key={bubble.at}
                  role="status"
                  className="pointer-events-auto absolute bottom-full mb-2 w-max max-w-[16rem] rounded-card border border-line bg-surface px-3 py-2 text-ink shadow-[var(--shadow-toast)]"
                  // Over Rico, shifted so it stays on the screen at either end.
                  style={{ left: '50%', x: `-${Math.round(x * 100)}%` }}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.15 } }}
                >
                  <div className="flex items-start gap-2">
                    <p className="t-body text-ink">{bubble.text}</p>
                    <button type="button" aria-label="Not now" onClick={() => setState({ ricoBubble: null })} className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-muted">
                      <X size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {bubble.replies.map((r) => (
                      <button key={r.label} type="button" onClick={() => reply(r)} className="min-h-10 rounded-full bg-green px-3 t-small font-bold text-on-green">
                        {r.label}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <motion.button
              type="button"
              aria-label="Rico: tap to talk"
              onClick={tap}
              className="pointer-events-auto block rounded-full"
              animate={walking && !reduce ? { y: [0, -6, 0] } : { y: 0 }}
              transition={walking && !reduce ? { repeat: Infinity, duration: 0.36 } : { duration: 0.2 }}
            >
              <span className="block transition-transform duration-200" style={{ transform: `scaleX(${facing})` }}>
                <RooAvatar mood={walking ? 'happy' : mood} size={64} reduce={reduce} hop={hop} />
              </span>
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default RicoPal
