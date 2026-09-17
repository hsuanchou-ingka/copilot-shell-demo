import { useEffect, useState } from 'react'
import './demo-tour.css'

// A short guided tour shown only inside the public web demo, never in the real
// Electron app. It walks a visitor past the four regions of the interface and then
// points at the install instructions. Dismissal is remembered in localStorage so a
// returning visitor is not shown it again, but a quiet pill lets them restart it.

const STORAGE_KEY = 'copilot-demo-tour-dismissed'

const STEPS = [
  {
    selector: '.sidebar',
    title: 'Every session, in one place',
    body: 'All of your Copilot sessions live here. The sidebar shows which one is working and which one is waiting on you.',
  },
  {
    selector: '.conversation',
    title: 'Talk to Copilot',
    body: 'The conversation happens here. Answers can render as tables, links and file attachments.',
  },
  {
    selector: '.plan-hud',
    title: 'Follow the plan',
    body: 'See what Copilot is doing right now, one step at a time, instead of guessing from a percentage.',
  },
  {
    selector: '.composer-wrap',
    title: 'Keep typing',
    body: 'Write your next message while a turn is still running. It queues up and sends once the current turn ends.',
  },
  {
    selector: null,
    title: 'Made up data',
    body: 'Everything on this page is fabricated for the demo. Install the real app to use it with your own sessions.',
    install: 'https://github.com/hsuanchou-ingka/copilot-shell-demo#install',
  },
]

const REQUIRED_SELECTORS = ['.sidebar', '.conversation', '.plan-hud', '.composer-wrap']

function readDismissed() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Ignore storage failures, such as private browsing modes that reject writes.
  }
}

function placeCard(rect) {
  const GAP = 16
  const MARGIN = 12
  const CARD_WIDTH = 300
  const CARD_HEIGHT = 170
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  const spaceRight = viewportWidth - (rect.left + rect.width)
  const spaceLeft = rect.left
  const spaceBelow = viewportHeight - (rect.top + rect.height)

  let top
  let left

  if (spaceRight >= CARD_WIDTH + GAP) {
    left = rect.left + rect.width + GAP
    top = rect.top + rect.height / 2 - CARD_HEIGHT / 2
  } else if (spaceLeft >= CARD_WIDTH + GAP) {
    left = rect.left - GAP - CARD_WIDTH
    top = rect.top + rect.height / 2 - CARD_HEIGHT / 2
  } else if (spaceBelow >= CARD_HEIGHT + GAP) {
    top = rect.top + rect.height + GAP
    left = rect.left + rect.width / 2 - CARD_WIDTH / 2
  } else {
    top = rect.top - GAP - CARD_HEIGHT
    left = rect.left + rect.width / 2 - CARD_WIDTH / 2
  }

  left = Math.min(Math.max(left, MARGIN), viewportWidth - CARD_WIDTH - MARGIN)
  top = Math.min(Math.max(top, MARGIN), viewportHeight - CARD_HEIGHT - MARGIN)

  return { top, left }
}

// Tracks the on screen position of the current step's target with a resize aware
// polling loop, so it stays correct as the stage scale in demo.html changes.
function useTargetRect(selector) {
  const [rect, setRect] = useState(null)

  useEffect(() => {
    if (!selector) {
      setRect(null)
      return undefined
    }
    let frame = null
    let cancelled = false
    const measure = () => {
      if (cancelled) return
      const node = document.querySelector(selector)
      if (node) {
        const box = node.getBoundingClientRect()
        // Keep the previous object when nothing moved, so the loop does not force
        // a render on every frame.
        setRect((previous) => (
          previous
          && previous.top === box.top
          && previous.left === box.left
          && previous.width === box.width
          && previous.height === box.height
            ? previous
            : { top: box.top, left: box.left, width: box.width, height: box.height }
        ))
      } else {
        setRect(null)
      }
      frame = window.requestAnimationFrame(measure)
    }
    frame = window.requestAnimationFrame(measure)
    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [selector])

  return rect
}

export default function DemoTour() {
  const [stepIndex, setStepIndex] = useState(null)
  const [pillVisible, setPillVisible] = useState(false)

  // Wait until all four regions the tour points at actually exist before starting,
  // since a scene can still be populating the page when this component mounts.
  useEffect(() => {
    if (readDismissed()) {
      setPillVisible(true)
      return undefined
    }
    let cancelled = false
    const check = () => {
      if (cancelled) return
      if (REQUIRED_SELECTORS.every((selector) => document.querySelector(selector))) {
        setStepIndex(0)
        return
      }
      window.setTimeout(check, 150)
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  const running = stepIndex !== null
  const step = running ? STEPS[stepIndex] : null
  const rect = useTargetRect(step?.selector)

  function finish() {
    writeDismissed()
    setStepIndex(null)
    setPillVisible(true)
  }

  function next() {
    if (stepIndex === STEPS.length - 1) {
      finish()
      return
    }
    setStepIndex(stepIndex + 1)
  }

  function back() {
    if (stepIndex > 0) setStepIndex(stepIndex - 1)
  }

  function restart() {
    setPillVisible(false)
    setStepIndex(0)
  }

  useEffect(() => {
    if (!running) return undefined
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        finish()
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        next()
      } else if (event.key === 'ArrowLeft') {
        back()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, stepIndex])

  if (!running) {
    return pillVisible ? (
      <button type="button" className="demo-tour-pill" onClick={restart}>
        Take the tour
      </button>
    ) : null
  }

  const cardStyle = rect
    ? placeCard(rect)
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <>
      {rect ? (
        <div
          className="demo-tour-spotlight"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      ) : (
        <div className="demo-tour-scrim" />
      )}
      <div
        className={`demo-tour-card ${rect ? '' : 'centered'}`}
        style={rect ? { top: cardStyle.top, left: cardStyle.left } : undefined}
        role="dialog"
        aria-label="Guided tour"
      >
        <p className="demo-tour-step">{stepIndex + 1} / {STEPS.length}</p>
        <p className="demo-tour-title">{step.title}</p>
        <p className="demo-tour-body">{step.body}</p>
        <div className="demo-tour-actions">
          <button type="button" className="demo-tour-skip" onClick={finish}>
            Skip
          </button>
          {step.install && (
            <a
              className="demo-tour-install"
              href={step.install}
              target="_blank"
              rel="noreferrer"
            >
              Install it
            </a>
          )}
          <button type="button" className="demo-tour-next" onClick={next}>
            {stepIndex === STEPS.length - 1 ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </>
  )
}
