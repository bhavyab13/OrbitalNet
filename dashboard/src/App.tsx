import { Component, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { MOCK, connectLive } from './lib/sim'
import { useStore } from './store'
import { startMock } from './mock/stream'
import TopBar from './components/TopBar'
import Globe from './components/Globe'
import MissionHUD from './components/MissionHUD'
import PlanTable from './components/PlanTable'
import ProviderCards from './components/ProviderCards'
import { AuditFeed, Narration, PaymentTicker } from './components/RightColumn'
import ResultOverlay from './components/ResultOverlay'
import StoryStrip from './components/StoryStrip'
import Judge from './components/Judge'
import SponsorStamps from './components/SponsorStamps'
import Provenance from './components/Provenance'
import DemoLauncher from './components/DemoLauncher'
import DemoStrip from './components/DemoStrip'
import StripePanel from './components/StripePanel'
import InstaBoxPanel from './components/InstaBoxPanel'
import Reticle from './components/Reticle'

class Boundary extends Component<{ children: ReactNode; label: string }, { err?: string }> {
  state = { err: undefined as string | undefined }
  static getDerivedStateFromError(e: any) { return { err: String(e?.message ?? e) } }
  render() {
    if (this.state.err) return <div className="panel p-3 text-[11px] text-bad font-mono">{this.props.label} failed: {this.state.err}</div>
    return this.props.children
  }
}

/** The narrative caption yields to the demo step strip while a scripted demo runs (StoryStrip itself is owned by the cinematic pass). */
function StoryWhenIdle() {
  const demo = useStore((s) => s.demo)
  if (demo.running || demo.done) return null
  return <StoryStrip />
}

function ControlRoom() {
  return (
    <div className="relative flex-1 min-h-0 grid-bg">
      <div className="absolute inset-0 vignette scanlines">
        <Boundary label="globe"><Globe /></Boundary>
        <Boundary label="reticle"><Reticle /></Boundary>
      </div>
      <div className="grain" />
      <div className="absolute inset-0 pointer-events-none grid grid-cols-[320px_1fr_330px] gap-3 p-3">
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden pointer-events-auto">
          <Boundary label="hud"><MissionHUD /></Boundary>
          <Boundary label="plans"><PlanTable /></Boundary>
          <Boundary label="providers"><ProviderCards /></Boundary>
          <Boundary label="instabox"><InstaBoxPanel /></Boundary>
        </div>
        <div className="relative min-h-0">
          <div className="absolute top-0 right-0"><Boundary label="sponsors"><SponsorStamps /></Boundary></div>
          <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between gap-3">
            <Boundary label="provenance"><Provenance /></Boundary>
            <div className="panel px-3 py-1.5 text-[10px] font-mono text-dim leading-4 pointer-events-none whitespace-nowrap flex gap-3">
              <span className="hidden 2xl:inline"><i className="inline-block w-4 border-t-2 border-dashed border-[#8caad2]/40 align-middle mr-1" />future</span>
              <span><i className="inline-block w-4 border-t-2 border-[#4fd1ff] align-middle mr-1" />open link</span>
              <span className="hidden 2xl:inline"><i className="inline-block w-4 border-t-2 border-dotted border-[#f87171] align-middle mr-1" />killed</span>
              <span><i className="inline-block w-2.5 h-2.5 rounded-full border border-[#a78bfa] align-middle mr-1" />grant</span>
              <span><i className="inline-block w-2.5 h-2.5 rounded-full border border-[#34d399] align-middle mr-1" />fulfilled</span>
              <span><i className="inline-block w-2 h-2 rounded-full bg-[#ffd166] align-middle mr-1" />money</span>
              <span className="hidden 2xl:inline"><i className="inline-block w-2 h-2 rounded-full bg-[#ff8c42] align-middle mr-1" />fire</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden pointer-events-auto">
          <Boundary label="narration"><Narration /></Boundary>
          <Boundary label="stripe"><StripePanel /></Boundary>
          <Boundary label="payments"><PaymentTicker /></Boundary>
          <Boundary label="audit"><AuditFeed /></Boundary>
        </div>
      </div>
      <StoryWhenIdle />
      <Boundary label="demo-strip"><DemoStrip /></Boundary>
      <Boundary label="result"><ResultOverlay /></Boundary>
    </div>
  )
}

export default function App() {
  useEffect(() => (MOCK ? startMock() : connectLive()), [])
  return (
    <BrowserRouter>
      <div className="h-full flex flex-col">
        <TopBar />
        <Routes>
          <Route path="/" element={<div className="h-10 flex items-center gap-3 px-3 border-b border-line bg-[rgba(5,8,15,0.7)] backdrop-blur-md relative z-20"><span className="font-mono text-[10px] tracking-[0.25em] text-dim hidden md:block">SCRIPTED DEMOS</span><Boundary label="launcher"><DemoLauncher /></Boundary><span className="flex-1" /><span className="font-mono text-[10px] text-dim hidden lg:block">keys 1 · 2 · 3 start · esc stops</span></div>} />
          <Route path="/judge" element={null} />
        </Routes>
        <Routes>
          <Route path="/" element={<ControlRoom />} />
          <Route path="/judge" element={<div className="flex-1 min-h-0"><Judge /></div>} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
