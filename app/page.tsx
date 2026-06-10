import Link from 'next/link'
import Image from 'next/image'
import { HomeDemoVideo } from './components/HomeDemoVideo'
import { GetTheAppBanner } from './components/GetTheAppBanner'

const previews = [
  {
    id: 'product',
    label: 'Product Listing',
    caption: 'Find products, review ROI, list fast.',
    src: '/preview-product-listing.png',
    width: 1536,
    height: 864,
  },
  {
    id: 'financials',
    label: 'Financials',
    caption: 'Real profit after Amazon + eBay fees.',
    src: '/preview-financials.png',
    width: 1536,
    height: 864,
  },
  {
    id: 'performance',
    label: 'Performance',
    caption: 'What to list more of next.',
    src: '/preview-performance.png',
    width: 1536,
    height: 864,
  },
] as const

const pillars = [
  {
    title: 'Catalog Research',
    desc: 'Builds a fresh queue of listing candidates using market signals, margin math, demand indicators, image readiness, and seller fit.',
  },
  {
    title: 'Listing Guardrails',
    desc: 'Flags weak titles, bad pricing, duplicates, restricted categories, thin image sets, and other risky listings before publishing.',
  },
  {
    title: 'Performance Intelligence',
    desc: 'Shows which categories, niches, products, and margins are working so sellers can make better listing decisions over time.',
  },
]

const workflow = [
  'Connect eBay',
  'List 5 items free (trial)',
  'Upgrade when you’re ready',
  'Fulfill orders and track profit',
]

export default function Landing() {
  return (
    <main className="home-page">
      <nav className="home-nav">
        <Link href="/" className="home-brand" aria-label="StackPilot home">
          Stack<span>Pilot</span>
        </Link>
        <div className="home-nav-links" aria-label="Product sections">
          <Link href="/guide">How it works</Link>
          <a href="#get-app">Get App</a>
          <a href="#research">Research</a>
          <a href="#workflow">Workflow</a>
          <a href="#safety">Safety</a>
        </div>
        <div className="home-nav-actions">
          <Link href="/login" className="btn btn-ghost btn-sm">
            Sign In
          </Link>
          <Link href="/signup" className="btn btn-solid btn-sm">
            Create Account
          </Link>
        </div>
      </nav>

      <section className="home-hero">
        <div className="home-plane-wrap" aria-hidden="true">
          <span className="home-flight-path" />
          <Image className="home-plane" src="/stackpilot-plane.svg" alt="" width={240} height={240} priority />
        </div>

        <div className="home-hero-copy">
          <div className="home-kicker">
            <span />
            Live eBay seller command center
          </div>
          <h1>StackPilot</h1>
          <p>
            A cleaner operating system for eBay sellers. Connect your account, list 5 items free, and upgrade only when you’re ready.
          </p>
          <div className="home-trial-note" aria-label="Trial note">
            No card required · Trial ends after 5 published listings
          </div>
          <div id="get-app">
            <GetTheAppBanner variant="marketing" />
          </div>
          <div className="home-actions">
            <Link href="/signup" className="btn btn-solid">
              Create Account
            </Link>
            <Link href="/guide" className="btn btn-ghost">
              How it works
            </Link>
            <Link href="/login" className="btn btn-ghost">
              Sign In
            </Link>
          </div>
        </div>

        <div className="home-command-preview" aria-label="StackPilot dashboard preview">
          <div className="home-preview-bar">
            <div>
              <span>Dashboard Preview</span>
              <strong>See what sellers use every day</strong>
            </div>
            <em>Live UI</em>
          </div>

          <div className="home-preview-tabs" role="tablist" aria-label="Dashboard previews">
            {previews.map((preview, index) => (
              <label key={preview.id} className="home-preview-tab">
                <input type="radio" name="home-preview" defaultChecked={index === 0} />
                <span>
                  <strong>{preview.label}</strong>
                  <em>{preview.caption}</em>
                </span>
              </label>
            ))}
          </div>

          <div className="home-preview-stage">
            {previews.map((preview, index) => (
              <div key={preview.id} className="home-preview-shot" data-default={index === 0 ? '1' : '0'}>
                <Image
                  src={preview.src}
                  alt={`${preview.label} preview`}
                  width={preview.width}
                  height={preview.height}
                  sizes="(max-width: 980px) 100vw, 980px"
                  priority={index === 0}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="research" className="home-section">
        <div className="home-section-heading">
          <span>What customers get</span>
          <h2>One dashboard for finding, listing, and running the business.</h2>
          <p>
            StackPilot is built for sellers who need speed without chaos. It keeps
            listing opportunities fresh, makes decisions clearer, and protects the
            account from sloppy automation.
          </p>
        </div>

        <div className="home-pillars">
          {pillars.map((pillar) => (
            <article key={pillar.title} className="home-pillar">
              <h3>{pillar.title}</h3>
              <p>{pillar.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="workflow" className="home-section home-flow-section">
        <div className="home-section-heading">
          <span>Daily workflow</span>
          <h2>Designed around how sellers actually list.</h2>
        </div>
        <div className="home-flow">
          {workflow.map((step, index) => (
            <div key={step} className="home-flow-step">
              <strong>{String(index + 1).padStart(2, '0')}</strong>
              <span>{step}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="demo" className="home-section">
        <div className="home-section-heading">
          <span>Getting started</span>
          <h2>Watch a quick walkthrough, then copy the workflow.</h2>
          <p>
            StackPilot is intentionally simple on mobile. List products, fulfill orders, and stay on top of profit and performance without dashboard clutter.
          </p>
        </div>

        <div className="home-demo-grid">
          <div className="home-demo-card">
            <HomeDemoVideo />
          </div>
          <div className="home-demo-steps">
            <div className="home-demo-step">
              <strong>1</strong>
              <div>
                <div className="home-demo-step__title">Connect eBay</div>
                <div className="home-demo-step__body">Sign in once. Sync brings orders and listing context into one place.</div>
              </div>
            </div>
            <div className="home-demo-step">
              <strong>2</strong>
              <div>
                <div className="home-demo-step__title">List products</div>
                <div className="home-demo-step__body">Review ROI, confirm pricing, and publish. Stable queues — no random reshuffling.</div>
              </div>
            </div>
            <div className="home-demo-step">
              <strong>3</strong>
              <div>
                <div className="home-demo-step__title">Fulfill orders</div>
                <div className="home-demo-step__body">Copy ship-to, open Amazon, and keep your seller metrics clean.</div>
              </div>
            </div>
            <div className="home-demo-cta">
              <Link href="/signup" className="btn btn-solid">
                Create Account
              </Link>
              <Link href="/login" className="btn btn-ghost">
                Sign In
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section id="safety" className="home-cta">
        <div>
          <span>Tester access</span>
          <h2>Built for sellers who want faster listing with better control.</h2>
          <p>
            New testers can create an account, connect eBay, and try the workflow
            with the built-in trial limit.
          </p>
        </div>
        <div className="home-actions">
          <Link href="/signup" className="btn btn-solid">
            Create Account
          </Link>
          <Link href="/login" className="btn btn-ghost">
            Sign In
          </Link>
        </div>
      </section>

      <footer className="home-footer">
        <Link href="/" className="home-brand" aria-label="StackPilot home">
          Stack<span>Pilot</span>
        </Link>
        <div>&copy; 2026 StackPilot. Catalog research, listing safety, and seller operations.</div>
      </footer>
    </main>
  )
}
