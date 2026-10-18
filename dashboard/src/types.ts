export type NodeRole = 'imaging' | 'compute' | 'relay'

export interface ScenarioNode {
  node_id: string
  role: NodeRole
  operator_id: string
  operator_name: string
  tle_name?: string
  color: string
  service_port?: number
  joins_late?: boolean
  onboard?: Record<string, unknown>
  capability?: Record<string, any>
}

export interface GroundStation {
  gs_id: string
  name: string
  lat: number
  lon: number
}

export type WindowStatus = 'future' | 'open' | 'closed' | 'killed'

export interface ContactWindow {
  window_id: string
  from: string
  to: string
  start: number
  end: number
  bandwidth_mbps: number
  kind: 'crosslink' | 'downlink'
  note?: string
  status?: WindowStatus
  capacity_mb?: number
  used_mb?: number
}

export interface Disruption {
  id: string
  label: string
  type: string
  window_id?: string
  node_id?: string
  fraction?: number
  suggested_sim_t?: number
}

export interface Scenario {
  scenario_id: string
  description: string
  epoch_utc: string
  sim: { accel: number; tick_s: number; horizon_s: number }
  mission: {
    mission_id: string
    buyer_id: string
    text: string
    source_node: string
    payload_mb: number
    op: string
    model: string
    result_mb_estimate: number
    deadline_sim_t: number
    budget_usd: number
    scene: { bbox: number[]; image_file: string; truecolor_file: string; truth_csv: string }
  }
  nodes: ScenarioNode[]
  ground_stations: GroundStation[]
  windows: ContactWindow[]
  disruptions: Disruption[]
  expected_story?: Record<string, any>
}

export interface PlanLeg {
  kind: 'transfer' | 'compute'
  from?: string
  to?: string
  node?: string
  window_id?: string
  start?: number
  end?: number
  bytes_mb?: number
  duration_s?: number
  quote_id?: string
  price_usd?: number
  status?: string
  bytes_moved_mb?: number
  attestation?: any
}

export interface Plan {
  plan_id: string
  label: string
  legs: PlanLeg[]
  delivery_sim_t?: number | null
  cost_usd?: number
  feasible: boolean
  reasons?: string[]
  chosen?: boolean
  fidelity?: 'full' | 'low'
  tradeoff?: string
}

export type MissionStatus =
  | 'IDLE'
  | 'PLANNED'
  | 'RUNNING'
  | 'REPLAN_REQUIRED'
  | 'DELIVERED'
  | 'INFEASIBLE'
  | 'FAILED'

export interface Position {
  lat: number
  lon: number
  alt_km: number
}

export interface NodeLive {
  online: boolean
  pos?: Position
  trail?: [number, number, number][] // lat, lon, alt
  trailT?: number[] // sim_t per trail point (live mode)
  capacity_pct?: number
  power_pct?: number
  price_usd?: number
  grants: { active: number; fulfilled: number; revoked: number }
  capacity_label?: string
}

export interface Payment {
  id: string
  sim_t: number
  operator_id: string
  node_id?: string
  amount_usd: number
  method: string
  receipt_ref: string
  description?: string
  /** OCGP §2.10 metered MPP session: amount counts up while bytes flow, then settles. */
  metered?: boolean
  settled?: boolean
  units?: number
  units_total?: number
  settlement_refs?: string[]
}

export interface AuditItem {
  id: string
  sim_t: number
  kind: 'grant_issued' | 'grant_rejected' | 'refund' | 'attestation' | 'info' | 'hold' | 'revoked'
  text: string
  detail?: string
  severity: 'ok' | 'warn' | 'bad' | 'info'
}

export interface NarrationItem {
  id: string
  sim_t: number
  act?: string
  text: string
}

export interface Transfer {
  window_id: string
  from: string
  to: string
  bytes_moved_mb: number
  bytes_total_mb: number
  pct: number
  done?: boolean
}

export interface MissionResult {
  geojson?: any
  summary?: Record<string, any>
  thumbnail_b64?: string
  delivered_sim_t?: number
  delivered_to?: string
}

export interface Hotspot {
  lat: number
  lon: number
  frp: number
  conf?: string
}

export interface SimEvent {
  type: string
  sim_t?: number
  [k: string]: any
}

// ---- demos + live proof panels
export interface DemoStep { title: string; detail?: string }
export interface DemoDef { id: number; title: string; subtitle?: string; steps: DemoStep[] }
export interface DemoState {
  running: boolean
  id?: number
  title?: string
  subtitle?: string
  step?: number
  total?: number
  stepTitle?: string
  stepDetail?: string
  startedAt?: number
  done?: { status: string; summary?: { delivered_sim_t?: number | null; total_paid_usd?: number; fidelity?: string; reconcile_ok?: boolean; reconcile_summary?: string }; at: number }
}
export interface StripePayment {
  id: string; amount_cents: number; currency: string; status: string
  intent: 'charge' | 'session' | null; created: number; description?: string | null; url?: string
}
export interface InstaBoxRow {
  name: string; state: string; template?: string; created?: string
  node_id?: string; operator_id?: string; role?: string; public_url?: string
  operator: { online: boolean; sim_t?: number; grants?: { active: number; fulfilled: number; revoked: number }; power_wh?: number; capacity?: Record<string, number>; rail?: string } | null
}
