// Rico checking in on his own (the server's 5-minute check, backend/app/workers/jobs.py): before a road leg at a
// time the roads are usually busy, or when the traveller looks behind. He pops up with "Hi, are you there? 👋",
// and when they answer, says why he came. The words here are what he says then.

import type { RicoBubble } from '@/lib/store'

/** The "HH:MM" of a time the server sends with its offset ("2026-10-15T19:53:00+05:30"): the trip's own time. */
function clockOf(iso: unknown): string | null {
  const m = /T(\d{2}:\d{2})/.exec(String(iso ?? ''))
  return m ? m[1] : null
}

function whole(n: unknown): number | null {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null
}

/** What Rico came to say, from the check-in's details. */
export function nudgeWords(data: Record<string, unknown>): string {
  const label = String(data.label ?? 'your next leg').replace(/\.$/, '')
  if (data.reason === 'behind') {
    const behind = whole(data.behindMin)
    return `${behind ? `You're about ${behind} minutes behind` : "You're running behind"} for ${label}. Want me to re-plan the rest of your day?`
  }
  const extra = whole(data.extraMin)
  const by = clockOf(data.suggestLeaveBy)
  return (
    `Roads are usually busy around now, so ${label} could take ${extra ? `about ${extra} minutes` : 'a bit'} longer. ` +
    `${by ? `Leaving by ${by}` : 'Leaving a little earlier'} would be safer. Want me to move your plan?`
  )
}

/** Rico's bubble for a check-in: "Hi, are you there? 👋", and the answer that has him explain. */
export function nudgeBubble(data: Record<string, unknown>, now = Date.now()): RicoBubble {
  return { text: 'Hi, are you there? 👋', replies: [{ label: 'Hi Rico, what’s up?', then: 'voice', say: nudgeWords(data) }], at: now }
}
