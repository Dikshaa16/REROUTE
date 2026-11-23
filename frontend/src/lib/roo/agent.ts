// Roo as an agent (the server's /v1/roo, when the AI helper has a Gemini key): a message goes to the model
// with the day, and comes back as Roo's reply, what it read, a question to tap, or one card of changes.
// Nothing changes until the traveller taps Do all on the card; Undo takes it back.

import { api, newKey } from '@/api/client'
import type { RooAgentOut, RooRun } from '@/api/types'
import type { RooAnswer } from './brain'

export interface AgentTurn {
  role: 'user' | 'roo'
  text: string
}

/** Words that ask Roo to do something beyond adding tasks: a ride, money, the app, a change to the day. */
const ACTS = /\b(book|cab|taxi|auto|ride|cancel|top ?up|wallet|dark|light|theme|voice|skip|undo|late|done|tell|remove|delete|move|shift)\b/i

/**
 * Should Roo's agent answer this? What the phone places with confidence stays on the phone (instant, and it
 * works offline). What it can't place, or a message asking for several things at once, goes to the agent.
 */
export function forAgent(said: string, local: RooAnswer): boolean {
  if (local.unknown || local.guess) return true
  const asks = said.split(/\b(?:and|then|also|plus)\b|[,;]/i).filter((part) => part.trim().split(/\s+/).length >= 2)
  return asks.length >= 2 && ACTS.test(said)
}

/** A described day that also asks for more ("…and book a cab") is the agent's; tasks alone are the phone's. */
export function asksMore(said: string): boolean {
  return ACTS.test(said)
}

/** "tourist": Rico is also the traveller's local guide (he reads city guides, nearby places and the web). */
export type AgentMode = 'tourist'

export function askAgent(message: string, history: AgentTurn[], tripId: string | null, mode?: AgentMode) {
  // The model may take a few steps (reading the day, places, fares), about five seconds each: up to half a minute.
  const body = { message: message.slice(0, 1000), history: history.slice(-12), tripId, ...(mode ? { mode } : {}) }
  return api.post<RooAgentOut>('/v1/roo/turns', body, { idempotencyKey: newKey('roo'), timeoutMs: 60_000 })
}

/** Rico's hello as a guide, and the two ways to start (each answer goes to his agent as the traveller's words). */
export function guideHello(cityName: string | undefined): { line: string; choices: string[] } {
  if (!cityName) return { line: 'Ooh, an adventure! I’ll be your guide 🧭 Which city are we exploring?', choices: [] }
  return { line: `Ooh, ${cityName}! I’ll be your guide today 🧭 Shall I recommend places to see, eat and do, or do you have some in mind?`, choices: ['Recommend places', 'I have places in mind'] }
}

export function runProposal(proposalId: string) {
  return api.post<RooRun>(`/v1/roo/proposals/${proposalId}/execute`, {}, { idempotencyKey: newKey('roo-run'), timeoutMs: 90_000 })
}

export function undoProposal(proposalId: string) {
  return api.post<RooRun>(`/v1/roo/proposals/${proposalId}/undo`, {}, { idempotencyKey: newKey('roo-undo'), timeoutMs: 90_000 })
}

/** Where an "open a screen" step goes. */
export const SCREEN_PATHS: Record<string, string> = {
  today: '/',
  plan: '/plan',
  summary: '/summary',
  why: '/why',
  raasta: '/raasta',
  me: '/me',
}
