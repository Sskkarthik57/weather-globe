// Globe camera controls: drag-rotate with inertia, wheel/pinch zoom, keyboard, tap detection,
// idle auto-rotate and a cinematic great-circle fly-to. No per-frame allocations.
import * as THREE from 'three';
import { DEG, clamp, easeInOutCubic, latLonToVec3, wrapLon } from './util.js';

const MIN_DIST = 1.12;
const MAX_DIST = 7;

export class GlobeControls {
  constructor(camera, dom, { onTap, onHover, onInteract } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.onTap = onTap;
    this.onHover = onHover;
    this.onInteract = onInteract;
    this.lat = 20; this.lon = 10; this.dist = 3.4; this.targetDist = 3.4;
    this.vLat = 0; this.vLon = 0; // deg per ms
    this.autoRotate = true;
    this.autoRotatePaused = false;
    this.lastInteraction = performance.now();
    this.pointers = new Map();
    this.dragging = false;
    this.fly = null;
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3();
    this._ll = { lat: 0, lon: 0 };
    this._changed = true;
    this._bind();
  }

  get moving() {
    return this.dragging || !!this.fly || Math.abs(this.vLat) + Math.abs(this.vLon) > 1e-6 ||
      Math.abs(this.targetDist - this.dist) > 1e-4 || this._autoActive();
  }
  _autoActive() {
    return this.autoRotate && !this.autoRotatePaused && !this.dragging && !this.fly &&
      performance.now() - this.lastInteraction > 6000;
  }

  _degPerPx() {
    const h = this.dom.clientHeight || 800;
    const fov = this.camera.fov * DEG;
    return ((this.dist - 1) * 2 * Math.tan(fov / 2) / h) / DEG;
  }

  _touch() { this.lastInteraction = performance.now(); this.fly = null; this.onInteract?.(); }

  _bind() {
    const d = this.dom;
    d.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      d.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, type: e.pointerType };
        this.last = { x: e.clientX, y: e.clientY, t: performance.now() };
        this.vLat = this.vLon = 0;
      } else if (this.pointers.size === 2) {
        this.pinch = { span: this._span(), dist: this.targetDist };
        if (this.down) this.down.moved = 99; // no tap
      }
      this._touch();
    });
    d.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) { if (e.pointerType === 'mouse') this.onHover?.(e.clientX, e.clientY); return; }
      p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size >= 2 && this.pinch) {
        const s = this._span();
        if (s > 0) this.targetDist = clamp(this.pinch.dist * (this.pinch.span / s), MIN_DIST, MAX_DIST);
        this._touch();
        return;
      }
      if (!this.down) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y;
      this.down.moved += Math.abs(dx) + Math.abs(dy);
      if (this.down.moved > 5) { this.dragging = true; d.classList.add('dragging'); }
      if (!this.dragging) return;
      const k = this._degPerPx();
      const cl = Math.max(Math.cos(this.lat * DEG), 0.25);
      const dLon = -dx * k / cl, dLat = dy * k;
      this.lon = wrapLon(this.lon + dLon);
      this.lat = clamp(this.lat + dLat, -85, 85);
      const now = performance.now();
      const dt = Math.max(1, now - this.last.t);
      this.vLon = this.vLon * 0.6 + (dLon / dt) * 0.4;
      this.vLat = this.vLat * 0.6 + (dLat / dt) * 0.4;
      this.last.x = e.clientX; this.last.y = e.clientY; this.last.t = now;
      this._changed = true;
      this._touch();
    });
    const up = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) {
        const dn = this.down;
        if (dn && dn.moved <= 6 && performance.now() - dn.t < 500 && e.type === 'pointerup') {
          this.onTap?.(e.clientX, e.clientY, dn.type);
        }
        if (performance.now() - (this.last?.t || 0) > 80) { this.vLat = this.vLon = 0; }
        this.down = null;
        this.dragging = false;
        d.classList.remove('dragging');
      }
    };
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
    d.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.onHover?.(-1, -1); });
    d.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.targetDist = clamp(this.targetDist * Math.exp(dy * 0.0011), MIN_DIST, MAX_DIST);
      this._touch();
    }, { passive: false });
    d.addEventListener('keydown', (e) => {
      const step = 8 * (this.dist - 1) / 2.4 + 1;
      let used = true;
      if (e.key === 'ArrowLeft') this.vLon = -step / 220;
      else if (e.key === 'ArrowRight') this.vLon = step / 220;
      else if (e.key === 'ArrowUp') this.vLat = step / 220;
      else if (e.key === 'ArrowDown') this.vLat = -step / 220;
      else if (e.key === '+' || e.key === '=') this.targetDist = clamp(this.targetDist * 0.8, MIN_DIST, MAX_DIST);
      else if (e.key === '-' || e.key === '_') this.targetDist = clamp(this.targetDist * 1.25, MIN_DIST, MAX_DIST);
      else used = false;
      if (used) { e.preventDefault(); this._touch(); }
    });
    // stop iOS page gestures
    d.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  _span() {
    const it = this.pointers.values();
    const a = it.next().value, b = it.next().value;
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  flyTo(lat, lon, dist = Math.min(this.dist, 2.3)) {
    latLonToVec3(this.lat, this.lon, 1, this._a);
    latLonToVec3(clamp(lat, -85, 85), lon, 1, this._b);
    const ang = this._a.angleTo(this._b);
    this.fly = {
      t0: performance.now(),
      dur: 900 + Math.min(1800, ang / DEG * 12),
      ang,
      d0: this.dist,
      d1: clamp(dist, MIN_DIST, MAX_DIST),
      hump: Math.min(1.4, ang * 0.55),
      from: this._a.clone(), to: this._b.clone(),
    };
    this.vLat = this.vLon = 0;
    this.lastInteraction = performance.now();
  }

  /** Advance one frame. Returns true if the camera moved. */
  update(dtMs) {
    let changed = this._changed;
    this._changed = false;
    if (this.fly) {
      const f = this.fly;
      const t = clamp((performance.now() - f.t0) / f.dur, 0, 1);
      const e = easeInOutCubic(t);
      if (f.ang > 1e-5) {
        const s = Math.sin(f.ang);
        const wa = Math.sin((1 - e) * f.ang) / s, wb = Math.sin(e * f.ang) / s;
        this._c.set(f.from.x * wa + f.to.x * wb, f.from.y * wa + f.to.y * wb, f.from.z * wa + f.to.z * wb);
        this.lat = Math.asin(clamp(this._c.y / this._c.length(), -1, 1)) / DEG;
        this.lon = Math.atan2(-this._c.z, this._c.x) / DEG;
      }
      this.dist = f.d0 + (f.d1 - f.d0) * e + f.hump * Math.sin(Math.PI * e);
      this.targetDist = this.dist;
      if (t >= 1) { this.fly = null; this.targetDist = this.dist = f.d1; }
      changed = true;
    } else {
      if (!this.dragging && (this.vLat || this.vLon)) {
        this.lon = wrapLon(this.lon + this.vLon * dtMs);
        this.lat = clamp(this.lat + this.vLat * dtMs, -85, 85);
        const damp = Math.exp(-dtMs / 260);
        this.vLon *= damp; this.vLat *= damp;
        if (Math.abs(this.vLon) < 1e-5 && Math.abs(this.vLat) < 1e-5) this.vLon = this.vLat = 0;
        changed = true;
      }
      if (Math.abs(this.targetDist - this.dist) > 1e-4) {
        this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-dtMs / 110));
        changed = true;
      }
      if (this._autoActive()) {
        this.lon = wrapLon(this.lon + dtMs * 0.0016);
        changed = true;
      }
    }
    if (changed) {
      latLonToVec3(this.lat, this.lon, this.dist, this.camera.position);
      this.camera.lookAt(0, 0, 0);
      // near/far tuned to distance for depth precision
      this.camera.near = Math.max(0.01, (this.dist - 1) * 0.3);
      this.camera.updateProjectionMatrix();
    }
    return changed;
  }
}
