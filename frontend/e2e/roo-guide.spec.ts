import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Rico as the local guide end to end: the glasses go on, he greets as a guide and answers as one, and entry
// tickets show in the trip's bookings as a ticket. Needs the full stack with DEMO_LOGIN=true; the guide also
// needs Rico's agent (AI_HELPER_ENABLED=true with a Gemini key, or ROO_FAKE_LLM as CI runs it).
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

const TRIP = 'trip-001'

async function api(page: Page) {
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  return { Authorization: `Bearer ${token}` }
}

async function resetDemo(page: Page) {
  const res = await page.request.post(`/v1/trips/${TRIP}/demo/reset`, { headers: await api(page), data: { idempotencyKey: `e2e-guide-reset-${Date.now()}` } })
  expect(res.ok()).toBe(true)
}

/** Signed in on the page first: an API sign-in shares the browser's cookies, and /signin would skip ahead. */
async function signIn(page: Page) {
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
  await resetDemo(page)
}

test.afterEach(async ({ page }) => resetDemo(page))

test('Rico puts on his guide glasses, asks how to start, and answers as a guide', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  const me = (await (await page.request.get('/v1/me', { headers: await api(page) })).json()) as { features?: { agent?: boolean } }
  test.skip(!me.features?.agent, "Rico's agent is off on this server (AI_HELPER_ENABLED with a Gemini key, or ROO_FAKE_LLM)")
  await page.goto('/plan')
  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  const glasses = chat.getByRole('button', { name: 'Rico as your local guide' })
  await expect(glasses).toHaveAttribute('aria-pressed', 'false')
  await glasses.click()
  await expect(glasses).toHaveAttribute('aria-pressed', 'true')
  await expect(chat.getByText('Your guide to Bengaluru')).toBeVisible({ timeout: 15_000 })
  await expect(chat.getByRole('log')).toContainText('Shall I recommend places to see, eat and do, or do you have some in mind?')
  await expect(chat.getByRole('button', { name: 'Recommend places' })).toBeVisible()
  await expect(chat.getByRole('button', { name: 'I have places in mind' })).toBeVisible()
  const scan = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])

  // As a guide, every message goes to his agent in tourist mode (the phone's own patterns can't recommend places).
  const asked = page.waitForRequest((r) => r.url().endsWith('/v1/roo/turns') && r.method() === 'POST')
  await chat.getByLabel('Message Rico').fill('I’m new here, show me around')
  await chat.getByRole('button', { name: 'Send' }).click()
  expect((await asked).postDataJSON()).toMatchObject({ mode: 'tourist', tripId: TRIP })
  await expect(chat.getByRole('log')).toContainText('Want me to plan your whole day, tickets and all?', { timeout: 60_000 })

  // He keeps them on for the next visit, and takes them off when asked.
  await page.reload()
  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  await expect(glasses).toHaveAttribute('aria-pressed', 'true')
  await glasses.click()
  await expect(chat.getByRole('log')).toContainText('Glasses off! I’m back to looking after your day.')
  await expect(glasses).toHaveAttribute('aria-pressed', 'false')
})

test('entry tickets show in the trip’s bookings as a ticket, with Cancel', async ({ page }) => {
  await signIn(page)
  const headers = await api(page)
  const me = (await (await page.request.get('/v1/me', { headers })).json()) as { features?: { bookings?: boolean } }
  test.skip(!me.features?.bookings, 'Simulated bookings are off on this server')
  // A sight of the traveller's own, ticketed as Rico would (his card books through the same API).
  const place = await page.request.post('/v1/me/places', {
    headers,
    data: { idempotencyKey: `e2e-guide-place-${Date.now()}`, name: 'Lalbagh Botanical Garden', category: 'sight', lng: 77.5848, lat: 12.9507, citySlug: 'bengaluru' },
  })
  expect(place.status()).toBe(201)
  const { placeId } = (await place.json()) as { placeId: string }
  try {
    const booked = await page.request.post(`/v1/trips/${TRIP}/bookings`, {
      headers,
      data: { idempotencyKey: `e2e-guide-ticket-${Date.now()}`, kind: 'ticket', placeId, visitDate: '2026-10-14', optionId: 'guided', visitors: 2 },
    })
    expect(booked.status()).toBe(201)
    const ticket = (await booked.json()) as { reference: string; fareInr: number }

    await page.goto('/plan')
    const row = page.getByRole('button', { name: /Lalbagh Botanical Garden, SightPass/ })
    await expect(row).toContainText(`Ticket ${ticket.reference}`)
    await row.click()
    const sheet = page.getByRole('dialog', { name: 'Your tickets' })
    await expect(sheet).toContainText('Entry and a guided tour, 2 people')
    await expect(sheet).toContainText(`Ticket ${ticket.reference}`)
    await sheet.getByRole('button', { name: 'Cancel the tickets' }).click()
    const toasts = page.getByRole('region', { name: /Notifications/ })
    await expect(toasts.getByRole('listitem').filter({ hasText: /Cancelled\. ₹[\d,]+ is back in your wallet/ })).toBeVisible()
  } finally {
    await page.request.delete(`/v1/me/places/${placeId}`, { headers })
  }
})
