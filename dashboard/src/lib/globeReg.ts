/** Shared handle to the live globe instance + node positions, so overlays (reticles, beams) can project into its camera. */
import type { GlobeMethods } from 'react-globe.gl'
import type { Position } from '../types'

export const globeReg: { globe?: GlobeMethods; pos: { current: Record<string, Position> } } = { pos: { current: {} } }
export const R_KM = 6371
/** Display altitude in globe radii; GEO compressed so it stays in frame. */
export const dispAlt = (altKm: number) => (altKm > 20000 ? 0.85 + 0.15 * Math.min(1, (altKm - 20000) / 20000) : altKm / R_KM)
if (typeof window !== 'undefined') (window as any).__globeReg = globeReg
