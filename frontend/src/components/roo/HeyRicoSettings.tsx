import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Switch } from '@/components/ui/Choice'
import { native } from '@/lib/platform'
import { showToast } from '@/lib/store'

type WakeStatus = Awaited<ReturnType<NonNullable<typeof native.wake>['status']>>

const READY = 'Say “Hey Rico” any time, even with Reroute closed.'

/**
 * "Hey Rico" in Me, in the Android app (a browser has no ear for it): say it and Rico comes up talking. He listens
 * on the phone itself, only while Reroute is open, or even when it's closed (Android then shows "Rico is listening"
 * all the while). The first time, his ear (the speech model) downloads. Rico's offer on Today (Roo) brings the
 * traveller here to set it all up at once: his ear, listening even with Reroute closed, and popping up.
 */
export function HeyRicoSettings() {
  const wake = native.wake
  const location = useLocation()
  const navigate = useNavigate()
  const [status, setStatus] = useState<WakeStatus | null>(null)
  const [downloading, setDownloading] = useState<number | null>(null)
  const here = useRef<HTMLDivElement>(null)
  // Off to Android's "Display over other apps" page: back from it, a word on how it went.
  const overlayAsked = useRef(false)

  useEffect(() => {
    const read = () =>
      void wake
        ?.status()
        .then((s) => {
          setStatus(s)
          if (!overlayAsked.current || document.visibilityState !== 'visible') return
          overlayAsked.current = false
          showToast({ title: s.popUp ? `All set! ${READY}` : 'Rico comes as a notification you tap instead. Let him pop up here any time.' })
        })
        .catch(() => setStatus(null))
    read()
    // Back from Android's "Display over other apps" page: whatever was chosen there.
    const back = () => document.visibilityState === 'visible' && read()
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [wake])

  /** True once it's on (or off); `quiet` leaves the word to whoever asked. */
  const turn = async (on: boolean, background: boolean, quiet = false) => {
    if (!wake) return false
    try {
      if (!on) await wake.stop()
      else {
        if (!status?.modelReady) {
          setDownloading(0)
          await wake.download((percent) => setDownloading(percent))
          setDownloading(null)
        }
        await wake.start(background)
        if (!quiet) showToast({ title: background ? READY : 'Say “Hey Rico” while Reroute is open.' })
      }
      setStatus(await wake.status())
      return true
    } catch (err) {
      setDownloading(null)
      showToast({ title: err instanceof Error && err.message ? err.message : 'Couldn’t turn “Hey Rico” on. Try again.' })
      return false
    }
  }

  /** Whether Android's page for it opened; null when it couldn't be changed. */
  const popUp = async (on: boolean) => {
    if (!wake) return null
    try {
      const { asked } = await wake.popUp(on)
      if (asked) {
        overlayAsked.current = true
        showToast({ title: 'Allow “Display over other apps” for Reroute, then come back.' })
      }
      setStatus(await wake.status())
      return asked
    } catch {
      showToast({ title: 'Couldn’t change that. Try again.' })
      return null
    }
  }

  // From Rico's offer: everything at once, here where it can be turned off again.
  const fromRico = (location.state as { heyRico?: boolean } | null)?.heyRico === true
  const loaded = status != null
  useEffect(() => {
    if (!fromRico || !loaded) return
    // Kept where it is, scrolled to here, so his ear's download shows.
    void navigate(location.pathname, { replace: true, state: null, preventScrollReset: true })
    here.current?.scrollIntoView?.({ block: 'center' })
    void (async () => {
      if (!(await turn(true, true, true))) return
      if ((await popUp(true)) === false) showToast({ title: `All set! ${READY}` })
    })()
    // Once, when the offer brought the traveller here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromRico, loaded])

  if (!wake || !status) return null

  return (
    <div ref={here}>
      <div className="border-t border-line" />
      <Switch
        label="“Hey Rico”"
        description={
          downloading != null
            ? `Downloading Rico’s ear… ${downloading}%`
            : 'Say “Hey Rico” and he comes up, ready to talk. He listens on this phone only: nothing leaves it until he wakes. The first time, his ear downloads (38 MB).'
        }
        checked={status.enabled}
        disabled={downloading != null}
        onChange={(v) => void turn(v, false)}
      />
      {status.enabled && (
        <>
          <div className="border-t border-line" />
          <Switch
            label="Even when Reroute is closed"
            description="Android shows “Rico is listening” while this is on. Rico answers as a notification you tap, or pops up by himself (below). It uses a little more battery."
            checked={status.background}
            onChange={(v) => void turn(true, v)}
          />
          {status.background && (
            <>
              <div className="border-t border-line" />
              <Switch
                label="Pop up over other apps"
                description="Call him in any app and he pops up at once, then opens talking: no notification to tap. Android asks you to allow “Display over other apps” for Reroute. Not over the lock screen."
                checked={status.popUp}
                onChange={(v) => void popUp(v)}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
