import { motion, useAnimationFrame, useMotionValue, useSpring, useTransform } from 'motion/react'
import { useRef } from 'react'
import type { LiveState } from '@/lib/roo/live'

/** How loud a voice is (0 … 1, the microphone's or Rico's own) as the glow's swell: speech sits around 0.02 to 0.1. */
export function swellOf(level: number): number {
  return Math.min(1, Math.max(0, level) * 10)
}

const GLOW = 'radial-gradient(circle, color-mix(in oklab, var(--green) 50%, transparent) 0%, color-mix(in oklab, var(--green) 20%, transparent) 46%, transparent 70%)'
const SHIMMER = 'conic-gradient(from 0deg, transparent 0deg, color-mix(in oklab, var(--green) 70%, transparent) 70deg, transparent 140deg)'
const RING = 'radial-gradient(circle, transparent 60%, black 61%, black 67%, transparent 68%)'

/**
 * The glow round Rico while he talks out loud, as a voice assistant's orb shows who's talking: it breathes while he
 * waits, swells with your voice as you speak (the microphone's loudness, frame by frame: his voice activity
 * detection made visible), turns a ring of light while he thinks, and pulses with his own voice as he answers.
 * Decorative: the status line says the same in words. With reduced motion it's a still glow.
 */
export function RicoAura({ state, you, rico, reduce }: { state: LiveState; you: number; rico: () => number; reduce: boolean }) {
  const yourVoice = useRef(you)
  yourVoice.current = you
  const target = useMotionValue(0)
  const swell = useSpring(target, { stiffness: 320, damping: 28 })
  const scale = useTransform(swell, (v) => 1 + v * 0.45)
  const opacity = useTransform(swell, (v) => 0.5 + v * 0.5)
  // A ring that rides the voice, as a voice assistant's waveform does.
  const ringScale = useTransform(swell, (v) => 1 + v * 0.3)
  const ringOpacity = useTransform(swell, (v) => Math.min(0.9, v * 1.6))
  useAnimationFrame(() => {
    if (reduce) return
    const level = state === 'speaking' ? rico() : state === 'listening' || state === 'hearing' ? yourVoice.current : 0
    target.set(swellOf(level))
  })
  const waiting = state === 'listening' || state === 'connecting'
  const voiced = state === 'hearing' || state === 'speaking' || state === 'listening'
  return (
    <span aria-hidden="true" data-aura={state} className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <motion.span className="absolute size-72 rounded-full" style={reduce ? { background: GLOW, opacity: 0.6 } : { background: GLOW, scale, opacity }} />
      {voiced && !reduce && <motion.span className="absolute size-60 rounded-full border-[3px] border-green" style={{ scale: ringScale, opacity: ringOpacity }} />}
      {waiting && !reduce && (
        // Breathing while he waits for you.
        <motion.span
          className="absolute size-60 rounded-full"
          style={{ background: GLOW }}
          animate={{ scale: [1, 1.1, 1], opacity: [0.35, 0.6, 0.35] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {state === 'thinking' && !reduce && (
        <motion.span
          className="absolute size-64 rounded-full"
          style={{ background: SHIMMER, mask: RING, WebkitMask: RING }}
          animate={{ rotate: 360 }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
        />
      )}
    </span>
  )
}
