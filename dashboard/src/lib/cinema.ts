/**
 * Cinematic layer for the globe: bloom post-processing, a real sun (key light + lens flare that is occluded by the planet),
 * a 3D starfield with a few bright flaring stars, and shared glow/flare textures.
 */
import * as THREE from 'three'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js'
import type { GlobeMethods } from 'react-globe.gl'

const texCache: Record<string, THREE.Texture> = {}

/** Soft radial glow dot. */
export function glowTex(color: string, size = 128) {
  const k = `g${color}${size}`
  if (texCache[k]) return texCache[k]
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0, '#ffffff')
  grd.addColorStop(0.15, color)
  grd.addColorStop(0.4, color + '55')
  grd.addColorStop(1, color + '00')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return (texCache[k] = t)
}

/** Anamorphic point flare: hot core + long horizontal streak + short vertical streak + faint halo. */
export function flareTex(color: string, size = 256, streak = 1) {
  const k = `f${color}${size}${streak}`
  if (texCache[k]) return texCache[k]
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const m = size / 2
  const halo = g.createRadialGradient(m, m, 0, m, m, m)
  halo.addColorStop(0, '#ffffff')
  halo.addColorStop(0.06, color)
  halo.addColorStop(0.22, color + '33')
  halo.addColorStop(1, color + '00')
  g.fillStyle = halo
  g.fillRect(0, 0, size, size)
  g.globalCompositeOperation = 'lighter'
  const h = g.createLinearGradient(0, m, size, m)
  h.addColorStop(0, color + '00'); h.addColorStop(0.5, '#ffffffcc'); h.addColorStop(1, color + '00')
  g.fillStyle = h
  g.fillRect(0, m - 1.2 * streak, size, 2.4 * streak)
  const h2 = g.createLinearGradient(0, m, size, m)
  h2.addColorStop(0, color + '00'); h2.addColorStop(0.5, color + '66'); h2.addColorStop(1, color + '00')
  g.fillStyle = h2
  g.fillRect(size * 0.1, m - 4 * streak, size * 0.8, 8 * streak)
  const v = g.createLinearGradient(m, 0, m, size)
  v.addColorStop(0, color + '00'); v.addColorStop(0.5, '#ffffff99'); v.addColorStop(1, color + '00')
  g.fillStyle = v
  g.fillRect(m - 1 * streak, size * 0.22, 2 * streak, size * 0.56)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return (texCache[k] = t)
}

function ringTex(color: string, size = 256, width = 10) {
  const k = `r${color}${size}${width}`
  if (texCache[k]) return texCache[k]
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.strokeStyle = color
  g.lineWidth = width
  g.shadowColor = color
  g.shadowBlur = width * 2
  g.beginPath(); g.arc(size / 2, size / 2, size / 2 - width * 2.5, 0, Math.PI * 2); g.stroke()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return (texCache[k] = t)
}

function hexTex(size = 128) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = 'rgba(255,255,255,0.9)'
  g.beginPath()
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; const x = size / 2 + Math.cos(a) * size * 0.42, y = size / 2 + Math.sin(a) * size * 0.42; i ? g.lineTo(x, y) : g.moveTo(x, y) }
  g.closePath(); g.fill()
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Sun placed over a lat/lon so its flare sits near the upper-left limb of the opening shot (Papua). */
export const SUN_LATLON = { lat: -2, lon: 176 }

export interface Cinema { sun: THREE.DirectionalLight; bloom: UnrealBloomPass; stars: THREE.Group; setSunByLatLon: (lat: number, lon: number) => void; placeSunForCamera: () => void }

export function setupCinema(globe: GlobeMethods, w: number, h: number): Cinema {
  const scene = globe.scene()
  // ---- lights: real key light + cool space fill
  const sun = new THREE.DirectionalLight(0xfff1dc, 3.4)
  const amb = new THREE.AmbientLight(0x4a5a78, 1.5)
  const hemi = new THREE.HemisphereLight(0x6f9fe0, 0x05070d, 0.5)
  const setSunByLatLon = (lat: number, lon: number) => {
    const c = (globe as any).getCoords(lat, lon, 30)
    sun.position.set(c.x, c.y, c.z)
  }
  setSunByLatLon(SUN_LATLON.lat, SUN_LATLON.lon)
  /** Key light behind-right-above the current camera: the hemisphere in view is lit with a terminator sweeping the lower-left,
   *  and the lens flare swings into frame whenever a camera move turns toward it. */
  const placeSunForCamera = () => {
    const cam = globe.camera()
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir)
    const right = new THREE.Vector3().crossVectors(dir, cam.up).normalize()
    const up = new THREE.Vector3().crossVectors(right, dir).normalize()
    const th = THREE.MathUtils.degToRad(128)
    const side = right.multiplyScalar(0.85).add(up.multiplyScalar(0.5)).normalize()
    const d = dir.multiplyScalar(Math.cos(th)).add(side.multiplyScalar(Math.sin(th))).normalize()
    sun.position.copy(d.multiplyScalar(3100))
  }
  globe.lights([amb, hemi, sun])

  // ---- lens flare on the sun (occluded by the planet automatically)
  const flare = new Lensflare()
  flare.addElement(new LensflareElement(flareTex('#fff3dc', 512, 2.2), 520, 0, new THREE.Color(0xfff0d0)))
  flare.addElement(new LensflareElement(glowTex('#ffd9a0', 256), 160, 0, new THREE.Color(0xffd9a0)))
  flare.addElement(new LensflareElement(ringTex('#9fd0ff', 256, 6), 70, 0.45, new THREE.Color(0x9fd0ff)))
  flare.addElement(new LensflareElement(hexTex(), 46, 0.62, new THREE.Color(0x6fb3ff)))
  flare.addElement(new LensflareElement(hexTex(), 110, 0.85, new THREE.Color(0xffb070)))
  flare.addElement(new LensflareElement(ringTex('#ffffff', 256, 3), 240, 1.05, new THREE.Color(0xbfe0ff)))
  flare.addElement(new LensflareElement(hexTex(), 60, 1.3, new THREE.Color(0x8fc8ff)))
  sun.add(flare)

  // ---- bloom (threshold high enough that the daylit planet stays crisp; flares, beams, rings and atmosphere bloom)
  const composer = globe.postProcessingComposer()
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.32, 0.9)
  composer.addPass(bloom)

  // ---- 3D starfield: thousands of faint points plus a handful of bright flaring stars
  const stars = new THREE.Group()
  stars.name = 'starfield'
  const N = 5000
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), sz = new Float32Array(N)
  const tints = [[1, 1, 1], [0.8, 0.88, 1], [1, 0.92, 0.8], [0.9, 0.95, 1]]
  for (let i = 0; i < N; i++) {
    const r = 2400 + Math.random() * 600
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1)
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph); pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
    const t = tints[(Math.random() * tints.length) | 0], b = 0.35 + Math.pow(Math.random(), 3) * 0.65
    col[i * 3] = t[0] * b; col[i * 3 + 1] = t[1] * b; col[i * 3 + 2] = t[2] * b
    sz[i] = 0.6 + Math.pow(Math.random(), 4) * 2.4
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: glowTex('#ffffff', 64) }, uTime: { value: 0 } },
    vertexShader: `attribute float aSize; varying vec3 vC; varying float vS; uniform float uTime;
      void main(){ vC=color; vS=aSize; vec4 mv=modelViewMatrix*vec4(position,1.0); float tw=0.85+0.15*sin(uTime*0.0021*aSize+position.x);
      gl_PointSize = aSize*2.2*tw; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D uTex; varying vec3 vC; varying float vS; void main(){ vec4 t=texture2D(uTex,gl_PointCoord); gl_FragColor=vec4(vC*t.rgb, t.a*min(1.0,vS)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
  })
  stars.add(new THREE.Points(geo, mat))
  for (let i = 0; i < 22; i++) {
    const r = 2600
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1)
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex(i % 3 ? '#cfe6ff' : '#ffe2b8', 256, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 + Math.random() * 0.45 }))
    s.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th))
    const k = 18 + Math.random() * 40
    s.scale.set(k, k, 1)
    stars.add(s)
  }
  // faint nebula haze patches
  for (let i = 0; i < 6; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1), r = 2800
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(i % 2 ? '#3b5bb0' : '#6a3f9a', 256), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.12 }))
    s.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th))
    const k = 900 + Math.random() * 900
    s.scale.set(k, k * (0.4 + Math.random() * 0.5), 1)
    stars.add(s)
  }
  scene.add(stars)
  const tick = () => { mat.uniforms.uTime.value = performance.now(); requestAnimationFrame(tick) }
  tick()
  return { sun, bloom, stars, setSunByLatLon, placeSunForCamera }
}
