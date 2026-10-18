/**
 * Beams: how money and bytes move on the globe. A beam is a two-layer tube (hot core + soft fresnel glow) along a lifted
 * great-circle path, with a traveling head, a packet train streaming along it, and a retract phase. Money = gold uplink from
 * the buyer's ops centre to the provider; refunds flow back down; data = cyan/white link that stays lit while bytes move.
 */
import * as THREE from 'three'
import { flareTex, glowTex } from '../lib/cinema'

const VERT = `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){ vUv=uv; vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vV=-mv.xyz; gl_Position=projectionMatrix*mv; }`
const FRAG = `uniform vec3 uColor; uniform float uHead; uniform float uTail; uniform float uTime; uniform float uAlpha; uniform float uPackets; uniform float uSpeed; uniform float uCore;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  float u=vUv.x;
  if(u>uHead||u<uTail) discard;
  float rim = uCore>0.5 ? 1.0 : pow(max(dot(normalize(vN),normalize(vV)),0.0),2.2);
  float edge = smoothstep(0.0,0.03,u-uTail)*smoothstep(0.0,0.015,uHead-u);
  float packets = 0.0;
  for(int i=0;i<3;i++){ float ph=fract(u*uPackets - uTime*uSpeed + float(i)*0.333); packets += exp(-pow(ph*9.0,2.0)); }
  float head = exp(-pow((uHead-u)*60.0,2.0));
  float I = uCore>0.5 ? min(1.25, 0.45 + packets*0.55 + head*1.4) : min(0.5, (0.07 + packets*0.22 + head*0.4)*rim);
  I *= edge;
  vec3 col = mix(uColor, vec3(1.0), clamp(head*0.7 + (uCore>0.5 ? packets*0.12 : 0.0), 0.0, 0.85));
  gl_FragColor = vec4(col*I, I*uAlpha);
}`

export interface BeamOpts { color: string; coreRadius?: number; glowRadius?: number; packets?: number; speed?: number }

export class Beam {
  group = new THREE.Group()
  private core: THREE.Mesh
  private glow: THREE.Mesh
  head: THREE.Sprite
  private hit: THREE.Sprite
  private cm: THREE.ShaderMaterial
  private gm: THREE.ShaderMaterial
  private opts: Required<BeamOpts>
  constructor(o: BeamOpts) {
    this.opts = { coreRadius: 0.14, glowRadius: 0.7, packets: 6, speed: 0.0014, ...o }
    const mk = (core: boolean) => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(o.color) }, uHead: { value: 0 }, uTail: { value: 0 }, uTime: { value: 0 }, uAlpha: { value: 1 }, uPackets: { value: this.opts.packets }, uSpeed: { value: this.opts.speed }, uCore: { value: core ? 1 : 0 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
    this.cm = mk(true); this.gm = mk(false)
    this.core = new THREE.Mesh(new THREE.BufferGeometry(), this.cm)
    this.glow = new THREE.Mesh(new THREE.BufferGeometry(), this.gm)
    this.head = new THREE.Sprite(new THREE.SpriteMaterial({ map: flareTex(o.color, 256, 1.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }))
    this.head.scale.set(5, 5, 1)
    this.hit = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(o.color, 128), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0 }))
    this.group.add(this.glow, this.core, this.head, this.hit)
  }
  /** Rebuild the path (endpoints move with the spacecraft) and set the visible segment. */
  update(pts: THREE.Vector3[], head: number, tail: number, alpha: number, now: number, hitPulse = 0) {
    const curve = new THREE.CatmullRomCurve3(pts)
    this.core.geometry.dispose(); this.glow.geometry.dispose()
    this.core.geometry = new THREE.TubeGeometry(curve, 48, this.opts.coreRadius, 6, false)
    this.glow.geometry = new THREE.TubeGeometry(curve, 48, this.opts.glowRadius, 10, false)
    for (const m of [this.cm, this.gm]) { m.uniforms.uHead.value = head; m.uniforms.uTail.value = tail; m.uniforms.uTime.value = now; m.uniforms.uAlpha.value = alpha }
    const hp = curve.getPoint(Math.max(0, Math.min(1, head)))
    this.head.position.copy(hp)
    const hs = (4.5 + 1.5 * Math.sin(now / 70)) * alpha
    this.head.scale.set(hs, hs, 1)
    ;(this.head.material as THREE.SpriteMaterial).opacity = head > 0.01 && head < 0.999 ? alpha : 0
    // arrival flash at the far end
    const end = pts[pts.length - 1]
    this.hit.position.copy(end)
    const k = 5 + 22 * hitPulse
    this.hit.scale.set(k, k, 1)
    ;(this.hit.material as THREE.SpriteMaterial).opacity = hitPulse > 0 ? (1 - hitPulse) * 0.95 : 0
  }
  dispose() { this.core.geometry.dispose(); this.glow.geometry.dispose(); this.cm.dispose(); this.gm.dispose() }
}
