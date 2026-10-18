import { Component, useEffect, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { MOCK, connectLive } from './lib/sim'
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

class Boundary extends Component<{ children: ReactNode; label: string }, { err?: string }> {
  state = { err: undefined as string | undefined }
  static getDerivedStateFromError(e: any) { return { err: String(e?.message ?? e) } }
  render() {
    if (this.state.err) return <div className="panel p-3 text-[11px] text-bad font-mono">{this.props.label} failed: {this.state.err}</div>
    return this.props.children
  }
}

function ControlRoom() {
  return (
    <div className="relative flex-1 min-h-0 grid-bg">
      <div className="absolute inset-0 vignette scanlines">
        <Boundary label="globe"><Globe /></Boundary>
      </div>
      <div className="absolute inset-0 pointer-events-none grid grid-cols-[320px_1fr_330px] gap-3 p-3">
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden pointer-events-auto">
          <Boundary label="hud"><MissionHUD /></Boundary>
          <Boundary label="plans"><PlanTable /></Boundary>
          <Boundary label="providers"><ProviderCards /></Boundary>
        </div>
        <div />
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden pointer-events-auto">
          <Boundary label="narration"><Narration /></Boundary>
          <Boundary label="payments"><PaymentTicker /></Boundary>
          <Boundary label="audit"><AuditFeed /></Boundary>
        </div>
      </div>
      <StoryStrip />
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
          <Route path="/" element={<ControlRoom />} />
          <Route path="/judge" element={<div className="flex-1 min-h-0"><Judge /></div>} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}
