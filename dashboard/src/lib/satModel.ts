/**
 * Procedural spacecraft models (no asset downloads): gold-foil bus, radiator-white nadir face, deployable solar wings,
 * dish or laser-terminal head depending on role; plus an anamorphic point flare that FxLayer pulses.
 */
import * as THREE from 'three'
import { flareTex } from './cinema'

const MAT = {
  gold: new THREE.MeshStandardMaterial({ color: 0xc8963a, metalness: 0.85, roughness: 0.4, emissive: 0x2a1a00, emissiveIntensity: 0.25 }),
  foilDark: new THREE.MeshStandardMaterial({ color: 0x5a4320, metalness: 0.95, roughness: 0.25 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe6eaf0, metalness: 0.4, roughness: 0.55 }),
  grey: new THREE.MeshStandardMaterial({ color: 0x8a94a6, metalness: 0.8, roughness: 0.4 }),
}
const panelMat = (color: string) => new THREE.MeshStandardMaterial({ color: 0x0f1d45, metalness: 0.75, roughness: 0.28, emissive: new THREE.Color(color), emissiveIntensity: 0.18 })
const cellMat = new THREE.MeshStandardMaterial({ color: 0x1b2f6b, metalness: 0.9, roughness: 0.2, emissive: 0x0a1a4a, emissiveIntensity: 0.3 })

function wing(len: number, w: number, color: string, segs = 3) {
  const g = new THREE.Group()
  const base = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, w), panelMat(color))
  g.add(base)
  // cell strips give the panel visible structure when lit
  const strip = len / segs
  for (let i = 0; i < segs; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(strip - 0.12, 0.05, w - 0.16), cellMat)
    m.position.set(-len / 2 + strip / 2 + i * strip, 0.04, 0)
    g.add(m)
  }
  const spar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 0.1), MAT.grey)
  spar.position.y = -0.05
  g.add(spar)
  return g
}

export function buildSatellite(id: string, color: string, role: string): THREE.Group {
  const g = new THREE.Group()
  g.name = `sat:${id}`
  const starlink = /STARLINK/i.test(id)
  const geo = role === 'relay' && !starlink
  const body = new THREE.Group()
  g.add(body)
  if (starlink) {
    // flat-panel bus with a single long wing and a laser terminal
    const bus = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.35, 1.6), MAT.white)
    body.add(bus)
    const w = wing(5.2, 1.5, color, 4); w.position.set(0, 0.25, -2.6); w.rotation.z = Math.PI / 2; w.rotation.y = Math.PI / 2
    body.add(w)
    const term = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 12), MAT.grey); term.rotation.x = Math.PI / 2; term.position.set(0.8, 0, 0.9)
    body.add(term)
  } else {
    const bus = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, geo ? 2.8 : 2.2), MAT.gold)
    body.add(bus)
    const nadir = new THREE.Mesh(new THREE.BoxGeometry(1.52, 1.52, 0.18), MAT.white); nadir.position.z = (geo ? 1.4 : 1.1)
    body.add(nadir)
    const rad = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.3, 1.6), MAT.foilDark); rad.position.set(0, -0.9, 0)
    rad.rotation.z = Math.PI / 2
    body.add(rad)
    if (geo || role === 'relay') {
      const dish = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 0.35, 0.5, 24, 1, true), MAT.white); dish.rotation.x = -Math.PI / 2; dish.position.z = 1.9
      body.add(dish)
      const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6), MAT.grey); feed.rotation.x = Math.PI / 2; feed.position.z = 2.3
      body.add(feed)
    } else if (role === 'compute') {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.8, 16), MAT.grey); lens.rotation.x = Math.PI / 2; lens.position.z = 1.5
      body.add(lens)
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), MAT.grey); ant.rotation.z = Math.PI / 2; ant.position.set(0, 0.9, -0.4)
      body.add(ant)
    } else {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 1.0, 16), MAT.white); lens.rotation.x = Math.PI / 2; lens.position.z = 1.6
      body.add(lens)
    }
    const span = geo ? 6.2 : 4.6
    for (const s of [-1, 1]) {
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6), MAT.grey); boom.rotation.z = Math.PI / 2; boom.position.set(s * 1.3, 0, 0)
      body.add(boom)
      const w = wing(span, geo ? 1.7 : 1.4, color, geo ? 4 : 3); w.position.set(s * (1.85 + span / 2), 0, 0)
      body.add(w)
    }
  }
  const k = (geo ? 0.9 : starlink ? 0.85 : 1) * 2.2
  body.scale.set(k, k, k)
  // point flare (billboard) — pulsed by FxLayer via userData
  const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex(color, 256, 1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0.9 }))
  flare.name = 'flare'
  flare.scale.set(9, 9, 1)
  g.add(flare)
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex('#ffffff', 128, 0.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 }))
  core.name = 'core'
  core.scale.set(2.2, 2.2, 1)
  g.add(core)
  g.userData = { sat: true, id, color, phase: Math.random() * Math.PI * 2 }
  return g
}
