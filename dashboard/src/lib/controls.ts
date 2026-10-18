import { MOCK, api } from './sim'
import { useStore } from '../store'

const mock = () => (window as any).__mockClock

export const clock = {
  pause: () => (MOCK ? mock()?.pause() : api.clock({ action: 'pause' }).then(() => useStore.setState({ paused: true })).catch(() => {})),
  resume: () => (MOCK ? mock()?.resume() : api.clock({ action: 'resume' }).then(() => useStore.setState({ paused: false })).catch(() => {})),
  setAccel: (accel: number) => (MOCK ? mock()?.setAccel(accel) : api.clock({ action: 'set_accel', accel }).then(() => useStore.setState({ accel })).catch(() => {})),
  jump: (to_sim_t: number) => (MOCK ? mock()?.jump(to_sim_t) : api.clock({ action: 'jump', to_sim_t }).catch(() => {})),
  reset: () => (MOCK ? mock()?.jump(0) : api.reset().then(() => useStore.getState().reset()).catch(() => {})),
}

export const disrupt = (d: { type: string; window_id?: string; node_id?: string; fraction?: number; label?: string }) =>
  MOCK ? Promise.resolve(mock()?.disrupt(d.type, d)) : api.disrupt(d)
