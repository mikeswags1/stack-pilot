'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

function HomeWalkthroughGuide() {
  const [step, setStep] = useState(0)

  const shots = [
    { src: '/preview-product-listing.png', label: 'Product listing', desc: 'Scan products, check ROI, publish fast.' },
    { src: '/preview-financials.png', label: 'Profit math', desc: 'Know what you actually made after fees.' },
    { src: '/preview-performance.png', label: 'Performance', desc: 'Double down on what’s working next.' },
  ] as const

  useEffect(() => {
    const id = window.setInterval(() => setStep((s) => (s + 1) % shots.length), 4500)
    return () => window.clearInterval(id)
  }, [shots.length])

  const current = shots[step] || shots[0]

  return (
    <div className="home-guide" aria-label="StackPilot quick start guide">
      <div className="home-guide__shot" aria-label="Walkthrough preview">
        <Image src={current.src} alt={`${current.label} screenshot`} fill sizes="(max-width: 940px) 100vw, 900px" />
        <div className="home-guide__overlay" aria-hidden="true" />
        <div className="home-guide__badge">
          <strong>Quick guide</strong>
          <span>{current.label}</span>
        </div>
        <div className="home-guide__dots" role="tablist" aria-label="Walkthrough steps">
          {shots.map((shot, idx) => (
            <button
              key={shot.src}
              type="button"
              className={`home-guide__dot${idx === step ? ' is-active' : ''}`}
              onClick={() => setStep(idx)}
              aria-label={`Show ${shot.label}`}
              aria-selected={idx === step}
              role="tab"
            />
          ))}
        </div>
      </div>

      <div className="home-guide__body">
        <div className="home-guide__title">No video yet — here’s the workflow.</div>
        <div className="home-guide__desc">
          <span>1.</span> Connect eBay once. <span>2.</span> List up to <strong>5 items free</strong>. <span>3.</span> Fulfill orders cleanly.
        </div>
        <div className="home-guide__actions">
          <Link href="/signup" className="btn btn-solid btn-sm">
            Create Account
          </Link>
          <Link href="/guide" className="btn btn-ghost btn-sm">
            Full guide
          </Link>
          <Link href="/login" className="btn btn-ghost btn-sm">
            Sign In
          </Link>
        </div>
      </div>
    </div>
  )
}

export function HomeDemoVideo() {
  const [failed, setFailed] = useState(false)

  const embedUrl = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_DEMO_VIDEO_URL || ''
    return raw.trim()
  }, [])

  if (embedUrl) {
    return (
      <div className="home-demo-frame" aria-label="StackPilot walkthrough video">
        <iframe
          className="home-demo-iframe"
          src={embedUrl}
          title="StackPilot walkthrough"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      </div>
    )
  }

  return (
    <div className="home-demo-frame" aria-label="StackPilot walkthrough video">
      {!failed ? (
        <video
          className="home-demo-video"
          controls
          playsInline
          preload="metadata"
          poster="/preview-product-listing.png"
          onError={() => setFailed(true)}
        >
          <source src="/stackpilot-demo.mp4" type="video/mp4" />
        </video>
      ) : (
        <HomeWalkthroughGuide />
      )}
    </div>
  )
}

