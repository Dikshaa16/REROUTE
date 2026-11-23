import * as Dialog from '@radix-ui/react-dialog'
import { Captions, CaptionsOff, Mic, MicOff, X } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Trip } from '@/api/types'
import { RooAvatar } from '@/components/roo3d/RooAvatar'
import { native } from '@/lib/platform'
import { askAgent, runProposal, undoProposal, type AgentTurn } from '@/lib/roo/agent'
import { openVoice, type LiveState, type VoiceSession } from '@/lib/roo/live'
import { ricoSound } from '@/lib/roo/sounds'
import { getState, setState, useStore, type RicoVoiceRequest } from '@/lib/store'
import type { Mood } from './mood'
import { PlanCard, type PlanCardData } from './PlanCard'
import { RicoAura } from './RicoAura'

interface Caption {
  who: 'you' | 'rico'
  text: string
}

/** Rico's face for each moment of the conversation. */
const FACE: Record<LiveState, Mood> = {
  connecting: 'wave',
  listening: 'listening',
  hearing: 'listening',
  thinking: 'thinking',
  speaking: 'talking',
  ended: 'sleeping',
}

const STATUS: Record<LiveState, string> = {
  connecting: 'Waking up…',
  listening: 'Listening…',
  hearing: 'Hearing you…',
  thinking: 'Thinking…',
  speaking: 'Rico is talking',
  ended: 'Bye for now',
}

/** Adds a piece of what someone said to the conversation's last few lines. */
export function addCaption(lines: Caption[], who: Caption['who'], text: string): Caption[] {
  const last = lines[lines.length - 1]
  const next = last && last.who === who ? [...lines.slice(0, -1), { who, text: last.text + text }] : [...lines, { who, text: text.trimStart() }]
  return next.slice(-4)
}

/**
 * Rico full screen, talking out loud in real time (Gemini Live), like a voice assistant with Rico in place of its
 * orb: he pops up from the bottom, a glow round him breathes while he listens and swells with the traveller's voice
 * as they speak, turns while he thinks, and pulses with his voice as he answers, his mouth moving to his words.
 * No chat on screen: captions only when asked for. Anything Reroute itself must do goes to his agent
 * (ask_reroute); a change comes up as a card here, and nothing happens until "Do all".
 */
export function RicoVoice({ trip }: { trip: Trip | undefined }) {
  const request = useStore((s) => s.ricoVoice)
  return (
    <Dialog.Root open={!!request} onOpenChange={(o) => !o && setState({ ricoVoice: null })}>
      <AnimatePresence>{request && <VoiceScreen key="voice" request={request} trip={trip} />}</AnimatePresence>
    </Dialog.Root>
  )
}

function VoiceScreen({ request, trip }: { request: RicoVoiceRequest; trip: Trip | undefined }) {
  const reduce = !!useReducedMotion()
  const [live, setLive] = useState<LiveState>('connecting')
  const [lines, setLines] = useState<Caption[]>(request.say ? [{ who: 'rico', text: request.say }] : [])
  const [level, setLevel] = useState(0)
  const [muted, setMuted] = useState(false)
  const [captions, setCaptions] = useState(false)
  const [card, setCard] = useState<PlanCardData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [boops, setBoops] = useState(0)
  const session = useRef<VoiceSession | null>(null)
  const heard = useRef<AgentTurn[]>([])
  const tripId = trip?.tripId ?? null
  // As the traveller's local guide (asked for, or guide mode on), for the whole conversation.
  const mode = request.mode ?? (getState().ricoGuide ? 'tourist' : undefined)

  useEffect(() => {
    let gone = false
    ricoSound('appear')
    // Rico's "Hey Rico" ear lets go of the microphone while he talks out loud. With Reroute in the back it listens
    // again (RicoListener), so back on screen it lets go once more.
    void native.wake?.pause()
    const back = () => {
      if (document.visibilityState === 'visible') void native.wake?.pause()
    }
    document.addEventListener('visibilitychange', back)
    openVoice(
      { tripId, mode },
      {
        state: (s) => {
          setLive(s)
          if (s === 'listening') ricoSound('listen')
          if (s === 'thinking') ricoSound('think')
        },
        caption: (who, text) => {
          setLines((all) => addCaption(all, who, text))
          const last = heard.current[heard.current.length - 1]
          const role: AgentTurn['role'] = who === 'you' ? 'user' : 'roo'
          if (last && last.role === role) last.text = (last.text + text).slice(-600)
          else heard.current = [...heard.current, { role, text }].slice(-12)
        },
        level: (v) => setLevel(v),
        tool: async (said) => {
          const out = await askAgent(said, heard.current.slice(0, -1), tripId, mode)
          if (out.proposal) {
            setCard({ proposal: out.proposal, state: 'ask' })
            ricoSound('happy')
            return `${out.reply} A change is waiting on a card: tell them to tap "Do all" to make it happen.`
          }
          return out.ask ? `${out.reply} (Choices: ${out.ask.options.join(', ')}.)` : out.reply
        },
        ended: (reason, message) => {
          if (reason !== 'stopped') setProblem(message ?? 'Rico had to go. Tap to talk again.')
        },
      },
    )
      .then((s) => {
        if (gone) s.stop()
        else {
          session.current = s
          // One of Rico's own nudges: he starts with it. Called by name, he says hello, as an assistant answers.
          if (request.say) s.note(`You came to tell the traveller: "${request.say}". Say it now, warmly, in your own words.`)
          else if (request.from === 'wake') s.note('The traveller just called you by saying "Hey Rico". Say a short, cheerful hello in a few words, like "Hi! I\'m here.", then listen.', true)
        }
      })
      .catch((err: unknown) => {
        setLive('ended')
        setProblem(err instanceof ApiError || err instanceof Error ? err.message : 'Rico can’t talk out loud right now.')
      })
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', back)
      session.current?.stop()
      session.current = null
      ricoSound('bye')
      void native.wake?.resume()
    }
    // One conversation per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const mute = () => {
    session.current?.mute(!muted)
    setMuted(!muted)
  }

  const refresh = async (changedTrip: string | null) => {
    void queryClient.invalidateQueries({ queryKey: keys.wallet })
    void queryClient.invalidateQueries({ queryKey: keys.trips })
    if (!changedTrip) return
    void queryClient.invalidateQueries({ queryKey: keys.trip(changedTrip) })
    void queryClient.invalidateQueries({ queryKey: keys.summary(changedTrip) })
    void queryClient.invalidateQueries({ queryKey: keys.bookings(changedTrip) })
    if (changedTrip !== tripId) setState({ tripId: changedTrip })
  }

  const doIt = async () => {
    if (!card) return
    setCard({ ...card, state: 'busy' })
    try {
      const run = await runProposal(card.proposal.proposalId)
      setCard({ ...card, state: run.state === 'done' ? 'done' : run.state === 'partial' ? 'partial' : 'failed', run })
      await refresh(run.tripId ?? null)
      ricoSound(run.state === 'failed' ? 'think' : 'happy')
      session.current?.note(`The traveller tapped "Do all". ${run.summary}`)
    } catch (err) {
      // Expired, already done, or the day changed since: the card can't run as it is.
      const why = err instanceof ApiError && err.status !== 0 ? err.message : 'No connection.'
      setCard({ ...card, state: err instanceof ApiError && err.status !== 0 ? 'expired' : 'ask', note: why })
      session.current?.note(`The card couldn't run: ${why}`)
    }
  }
  const undo = async () => {
    if (!card) return
    setCard({ ...card, state: 'undoing' })
    try {
      const out = await undoProposal(card.proposal.proposalId)
      setCard({ ...card, state: 'undone' })
      await refresh(out.tripId ?? null)
      session.current?.note(`The traveller tapped Undo. ${out.summary}`)
    } catch {
      setCard({ ...card, state: card.state })
    }
  }

  const face: Mood = problem ? 'sleeping' : FACE[live]
  const status = problem ? 'Not here right now' : muted ? 'Muted' : STATUS[live]

  return (
    <Dialog.Portal forceMount>
      <Dialog.Overlay asChild forceMount>
        <motion.div
          className="fixed inset-0 z-[60] bg-ground/90 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2 } }}
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
        />
      </Dialog.Overlay>
      <Dialog.Content
        aria-describedby={undefined}
        className="fixed inset-0 z-[60] flex flex-col items-center px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] text-ink outline-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Dialog.Title className="sr-only">Rico</Dialog.Title>
        <div className="flex w-full max-w-[560px] flex-1 flex-col items-center justify-center gap-8">
          {/* Rico pops up from the bottom, bounces into place, and sinks back down when he goes. */}
          <motion.div
            className="relative flex size-72 items-center justify-center"
            initial={reduce ? { opacity: 0 } : { y: '45vh', scale: 0.55, rotate: -10 }}
            animate={reduce ? { opacity: 1 } : { y: 0, scale: 1, rotate: 0, transition: { type: 'spring', stiffness: 240, damping: 15, mass: 0.9 } }}
            exit={reduce ? { opacity: 0 } : { y: '50vh', scale: 0.6, rotate: 8, transition: { duration: 0.32, ease: [0.4, 0, 1, 1] } }}
          >
            <RicoAura state={problem ? 'ended' : live} you={muted ? 0 : level} rico={() => session.current?.level() ?? 0} reduce={reduce} />
            <button
              type="button"
              className="relative rounded-full"
              aria-label="Boop Rico"
              onClick={() => {
                setBoops((n) => n + 1)
                ricoSound('giggle')
              }}
            >
              <RooAvatar mood={face} size={200} reduce={reduce} hop={boops} />
            </button>
          </motion.div>

          <div className="flex min-h-24 w-full flex-col items-center gap-3 text-center">
            <p className="t-display-2 text-ink" aria-live="polite">
              {status}
            </p>
            {problem ? (
              <p className="t-body text-ink-2">{problem}</p>
            ) : (
              captions &&
              lines.slice(-2).map((l, i) => (
                <p key={`${lines.length}-${i}`} className={l.who === 'rico' ? 't-title text-ink' : 't-body text-muted'}>
                  {l.who === 'you' ? `“${l.text.trim()}”` : l.text.trim()}
                </p>
              ))
            )}
          </div>

          {card && card.state !== 'no' && (
            <div className="w-full">
              <PlanCard plan={card} onRun={() => void doIt()} onDecline={() => setCard({ ...card, state: 'no' })} onUndo={() => void undo()} />
            </div>
          )}
        </div>

        <nav aria-label="Conversation" className="flex w-full max-w-[560px] items-center justify-center gap-6">
          <button
            type="button"
            onClick={mute}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute the microphone' : 'Mute the microphone'}
            className={`flex size-16 items-center justify-center rounded-full border-2 ${muted ? 'border-red bg-red-tint text-red-ink' : 'border-line bg-surface text-ink'}`}
          >
            {muted ? <MicOff size={26} strokeWidth={1.75} aria-hidden="true" /> : <Mic size={26} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => setCaptions((c) => !c)}
            aria-pressed={captions}
            aria-label="Captions"
            className={`flex size-16 items-center justify-center rounded-full border-2 ${captions ? 'border-ink bg-ink text-on-ink' : 'border-line bg-surface text-ink'}`}
          >
            {captions ? <Captions size={26} strokeWidth={1.75} aria-hidden="true" /> : <CaptionsOff size={26} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <Dialog.Close className="flex size-16 items-center justify-center rounded-full border-2 border-red bg-red-tint text-red-ink" aria-label="End the conversation">
            <X size={26} strokeWidth={2} aria-hidden="true" />
          </Dialog.Close>
        </nav>
      </Dialog.Content>
    </Dialog.Portal>
  )
}

export default RicoVoice
