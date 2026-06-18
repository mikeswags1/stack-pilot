import { redirect } from 'next/navigation'

// /admin now lands on the clean Owner Overview (the boss view). The previous
// 2,000-line operator console rendered blank in production; its code remains in
// git history, and the focused sub-tool pages (/admin/niches, /admin/performance,
// /admin/market, /admin/health, /admin/discovery) are still directly reachable.
export default function AdminIndex() {
  redirect('/admin/overview')
}
