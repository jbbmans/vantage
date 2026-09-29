import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MOMENTS } from '../src/moments.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FF_DIR = join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
const FFMPEG = join(FF_DIR, 'ffmpeg');
const ENV = { ...process.env, LD_LIBRARY_PATH: FF_DIR };
const SR = 48000;
const TL = JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'timelines.json'), 'utf8'));
const TAKES = existsSync(join(ROOT, 'src', 'generated', 'takes.json')) ? JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'takes.json'), 'utf8')) : {};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const cents = (c) => 2 ** (c / 1200);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pan2 = (pan) => { const th = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4; return [Math.cos(th), Math.sin(th)]; };

class Bus {
  constructor(seconds) { this.n = Math.ceil(seconds * SR); this.L = new Float32Array(this.n); this.R = new Float32Array(this.n); }
  /** Add a mono signal at time t (seconds), panned. */
  mono(t, sig, gain = 1, pan = 0) {
    const [gl, gr] = pan2(pan); const o = Math.round(t * SR);
    for (let i = 0; i < sig.length; i++) { const k = o + i; if (k < 0 || k >= this.n) continue; this.L[k] += sig[i] * gain * gl; this.R[k] += sig[i] * gain * gr; }
  }
  stereo(t, L, R, gain = 1) {
    const o = Math.round(t * SR);
    for (let i = 0; i < L.length; i++) { const k = o + i; if (k < 0 || k >= this.n) continue; this.L[k] += L[i] * gain; this.R[k] += R[i] * gain; }
  }
}

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function biquad(x, type, fc, q = 0.707, gainDb = 0) {
  let b0, b1, b2, a1, a2;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const set = (f) => {
    const w = (2 * Math.PI * clamp(f, 10, SR * 0.45)) / SR; const cs = Math.cos(w); const sn = Math.sin(w); const al = sn / (2 * q);
    let c0, c1, c2, d0, d1, d2;
    if (type === 'lp') { c0 = (1 - cs) / 2; c1 = 1 - cs; c2 = c0; d0 = 1 + al; d1 = -2 * cs; d2 = 1 - al; }
    else if (type === 'hp') { c0 = (1 + cs) / 2; c1 = -(1 + cs); c2 = c0; d0 = 1 + al; d1 = -2 * cs; d2 = 1 - al; }
    else if (type === 'bp') { c0 = al; c1 = 0; c2 = -al; d0 = 1 + al; d1 = -2 * cs; d2 = 1 - al; }
    else { const A = 10 ** (gainDb / 40); c0 = 1 + al * A; c1 = -2 * cs; c2 = 1 - al * A; d0 = 1 + al / A; d1 = -2 * cs; d2 = 1 - al / A; }
    b0 = c0 / d0; b1 = c1 / d0; b2 = c2 / d0; a1 = d1 / d0; a2 = d2 / d0;
  };
  const dyn = typeof fc === 'function';
  set(dyn ? fc(0) : fc);
  for (let i = 0; i < x.length; i++) {
    if (dyn && (i & 31) === 0) set(fc(i));
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}

function reverb(bus, { room = 0.86, damp = 0.32, pre = 0.02, width = 1 } = {}) {
  const k = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((x) => Math.round(x * k));
  const alls = [556, 441, 341, 225].map((x) => Math.round(x * k));
  const out = new Bus(bus.n / SR);
  const run = (inp, spread, outArr) => {
    const cb = combs.map((len) => ({ buf: new Float32Array(len + spread), i: 0, store: 0 }));
    const ab = alls.map((len) => ({ buf: new Float32Array(len + spread), i: 0 }));
    const pd = Math.round(pre * SR);
    for (let n = 0; n < inp.length; n++) {
      const x = (n >= pd ? inp[n - pd] : 0) * 0.015;
      let s = 0;
      for (const c of cb) {
        const y = c.buf[c.i]; c.store = y * (1 - damp) + c.store * damp; c.buf[c.i] = x + c.store * room; c.i = (c.i + 1) % c.buf.length; s += y;
      }
      for (const a of ab) { const b = a.buf[a.i]; const y = -s + b; a.buf[a.i] = s + b * 0.5; a.i = (a.i + 1) % a.buf.length; s = y; }
      outArr[n] = s;
    }
  };
  run(bus.L, 0, out.L); run(bus.R, 23, out.R);
  if (width < 1) for (let n = 0; n < out.n; n++) { const m = (out.L[n] + out.R[n]) / 2; out.L[n] = m + (out.L[n] - m) * width; out.R[n] = m + (out.R[n] - m) * width; }
  return out;
}

/** Ping-pong delay with a darkening feedback path. */
function pingpong(bus, time, fb = 0.34, mix = 0.28) {
  const d = Math.round(time * SR);
  const bl = new Float32Array(d); const br = new Float32Array(d);
  let i = 0; let lpL = 0; let lpR = 0;
  for (let n = 0; n < bus.n; n++) {
    const yl = bl[i]; const yr = br[i];
    lpL += (yr - lpL) * 0.35; lpR += (yl - lpR) * 0.35;
    bl[i] = bus.L[n] * 0.8 + lpL * fb; br[i] = bus.R[n] * 0.2 + lpR * fb;
    bus.L[n] += yl * mix; bus.R[n] += yr * mix;
    i = (i + 1) % d;
  }
}

function pad(bus, t, dur, notes, { amp = 0.05, attack = 1.4, release = 2.2, cut = [900, 900], q = 0.8, seed = 1, spread = 0.7 } = {}) {
  const r = rng(seed * 7919);
  const n = Math.ceil((dur + release) * SR);
  const L = new Float32Array(n); const R = new Float32Array(n);
  for (const m of notes) {
    for (let v = 0; v < 3; v++) {
      const f = mtof(m) * cents((v - 1) * 7 + (r() - 0.5) * 4);
      const dt = f / SR; let ph = r();
      const [gl, gr] = pan2((v - 1) * spread + (r() - 0.5) * 0.2);
      const drift = 0.0009 + r() * 0.0006; const dph = r() * 6.28;
      for (let i = 0; i < n; i++) {
        const tt = i / SR;
        const env = tt < attack ? (1 - Math.cos((Math.PI * tt) / attack)) / 2 : tt < dur ? 1 : Math.exp(-((tt - dur) / (release / 4)));
        const w = dt * (1 + drift * Math.sin(tt * 0.7 + dph));
        ph += w; if (ph >= 1) ph -= 1;
        const s = (2 * ph - 1 - polyblep(ph, w)) * env;
        L[i] += s * gl; R[i] += s * gr;
      }
    }
  }
  const fc = (i) => { const k = clamp(i / (dur * SR), 0, 1); return (cut[0] + (cut[1] - cut[0]) * k) * (1 + 0.12 * Math.sin(i / SR * 0.5)); };
  biquad(L, 'lp', fc, q); biquad(R, 'lp', fc, q);
  biquad(L, 'hp', 150); biquad(R, 'hp', 150);
  bus.stereo(t, L, R, amp / Math.sqrt(notes.length));
}

function felt(bus, t, m, { vel = 0.6, dur = 5, pan = 0 } = {}) {
  const f = mtof(m); const n = Math.ceil(dur * SR); const s = new Float32Array(n);
  const B = 0.00035;
  for (let k = 1; k <= 9; k++) {
    const fk = f * k * Math.sqrt(1 + B * k * k);
    if (fk > SR * 0.4) break;
    const amp = (1 / k ** 1.35) * (k === 1 ? 1 : 0.55 + vel * 0.4) * (k > 4 ? vel : 1);
    const tau = (dur / 2.2) / (1 + 0.5 * (k - 1));
    for (let i = 0; i < n; i++) { const tt = i / SR; s[i] += Math.sin(2 * Math.PI * fk * tt) * amp * Math.exp(-tt / tau) * Math.min(1, tt / 0.004); }
  }
  const r = rng(m * 31 + Math.round(t * 100));
  for (let i = 0; i < 0.012 * SR; i++) s[i] += (r() * 2 - 1) * 0.08 * vel * (1 - i / (0.012 * SR));
  biquad(s, 'lp', 1800 + vel * 4000, 0.6);
  bus.mono(t, s, vel * 0.3, pan);
}

/** A plucked synth note for the arpeggio. */
function pluck(bus, t, m, { vel = 0.5, pan = 0, bright = 1, len = 0.45 } = {}) {
  const f = mtof(m); const n = Math.ceil(len * SR); const s = new Float32Array(n);
  let ph = 0; const dt = f / SR; let ph2 = 0; const dt2 = (f * cents(6)) / SR;
  for (let i = 0; i < n; i++) {
    ph += dt; if (ph >= 1) ph -= 1; ph2 += dt2; if (ph2 >= 1) ph2 -= 1;
    const tt = i / SR;
    s[i] = ((2 * ph - 1 - polyblep(ph, dt)) + (2 * ph2 - 1 - polyblep(ph2, dt2))) * 0.5 * Math.exp(-tt / 0.16) * Math.min(1, tt / 0.002);
  }
  biquad(s, 'lp', (i) => 500 + 4200 * bright * Math.exp(-i / SR / 0.09), 1.2);
  biquad(s, 'hp', 180);
  bus.mono(t, s, vel * 0.22, pan);
}

function sub(bus, t, dur, m, { amp = 0.3 } = {}) {
  const f = mtof(m); const n = Math.ceil((dur + 0.4) * SR); const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const env = Math.min(1, tt / 0.08) * (tt < dur ? 1 : Math.exp(-(tt - dur) / 0.1));
    s[i] = Math.tanh(1.6 * Math.sin(2 * Math.PI * f * tt)) * env;
  }
  biquad(s, 'lp', 170, 0.7);
  bus.mono(t, s, amp * 0.5);
}

function kick(bus, t, { amp = 0.5 } = {}) {
  const n = Math.ceil(0.6 * SR); const s = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR; const f = 44 + 90 * Math.exp(-tt / 0.028);
    ph += f / SR; s[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-tt / 0.2) + Math.sin(2 * Math.PI * 180 * tt) * 0.25 * Math.exp(-tt / 0.02) + (i < 90 ? Math.sin(i * 1.7) * 0.08 * (1 - i / 90) : 0);
  }
  bus.mono(t, s, amp * 0.5);
}

/** A soft shaker: air on the sixteenths. */
function shaker(bus, t, { amp = 0.03, pan = 0.25 } = {}) {
  const n = Math.ceil(0.07 * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 3001));
  for (let i = 0; i < n; i++) { const tt = i / SR; s[i] = (r() * 2 - 1) * Math.min(1, tt / 0.006) * Math.exp(-tt / 0.022); }
  biquad(s, 'hp', 6500, 0.7);
  bus.mono(t, s, amp, pan);
}

function rim(bus, t, { amp = 0.12, pan = 0.1 } = {}) {
  const n = Math.ceil(0.12 * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 1000));
  for (let i = 0; i < n; i++) { const tt = i / SR; s[i] = (r() * 2 - 1) * Math.exp(-tt / 0.018) + Math.sin(2 * Math.PI * 1650 * tt) * 0.4 * Math.exp(-tt / 0.012); }
  biquad(s, 'bp', 1900, 1.2);
  bus.mono(t, s, amp, pan);
}

/** The hit: a sub that drops away, a dark burst, and air. */
function impact(bus, t, { amp = 0.8, size = 1 } = {}) {
  const n = Math.ceil(4.5 * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 997));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR; const f = 28 + 62 * Math.exp(-tt / 0.35);
    ph += f / SR;
    s[i] = Math.tanh(2.2 * Math.sin(2 * Math.PI * ph)) * Math.exp(-tt / (1.1 * size)) * 0.5 + Math.sin(2 * Math.PI * 118 * tt * (1 - tt * 0.1)) * Math.exp(-tt / 0.35) * 0.35;
  }
  const noise = new Float32Array(Math.ceil(1.6 * SR));
  for (let i = 0; i < noise.length; i++) noise[i] = (r() * 2 - 1) * Math.exp(-(i / SR) / 0.22);
  biquad(noise, 'lp', (i) => 9000 * Math.exp(-i / SR / 0.3) + 500, 0.7);
  bus.mono(t, s, amp);
  bus.mono(t, noise, amp * 0.5, -0.25); bus.mono(t + 0.011, noise, amp * 0.5, 0.25);
}

function riser(bus, t, dur, { amp = 0.25 } = {}) {
  const n = Math.ceil(dur * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 131));
  for (let i = 0; i < n; i++) { const k = i / n; s[i] = (r() * 2 - 1) * k ** 2.2; }
  biquad(s, 'bp', (i) => 300 * (20 ** (i / n)), 1.4);
  const tone = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const k = i / n; ph += (180 * 2 ** (k * 2)) / SR; tone[i] = Math.sin(2 * Math.PI * ph) * k ** 3 * 0.35; }
  bus.mono(t, s, amp, -0.3); bus.mono(t + 0.013, s, amp, 0.3); bus.mono(t, tone, amp * 0.6);
}

/** Air moving past: filtered noise, swept, panned across. */
function whoosh(bus, t, { dur = 0.8, amp = 0.16, from = -0.7, to = 0.7, lo = 350, hi = 2600 } = {}) {
  const n = Math.ceil(dur * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 173));
  for (let i = 0; i < n; i++) { const k = i / n; s[i] = (r() * 2 - 1) * Math.sin(Math.PI * k) ** 2; }
  biquad(s, 'bp', (i) => { const k = i / n; return lo + (hi - lo) * Math.sin(Math.PI * k); }, 1.2);
  const [a, b] = [from, to];
  const L = new Float32Array(n); const R = new Float32Array(n);
  for (let i = 0; i < n; i++) { const [gl, gr] = pan2(a + (b - a) * (i / n)); L[i] = s[i] * gl; R[i] = s[i] * gr; }
  bus.stereo(t, L, R, amp);
}

function tick(bus, t, { amp = 0.12, pitch = 2300, pan = 0 } = {}) {
  const n = Math.ceil(0.05 * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 5003));
  for (let i = 0; i < n; i++) { const tt = i / SR; s[i] = Math.sin(2 * Math.PI * pitch * tt * (1 - tt * 4)) * Math.exp(-tt / 0.009) + (i < 70 ? (r() * 2 - 1) * 0.5 * (1 - i / 70) : 0); }
  biquad(s, 'hp', 400);
  bus.mono(t, s, amp, pan);
}
function thock(bus, t, { amp = 0.2 } = {}) {
  const n = Math.ceil(0.09 * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 7001));
  for (let i = 0; i < n; i++) { const tt = i / SR; s[i] = Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.03) + (r() * 2 - 1) * 0.35 * Math.exp(-tt / 0.004); }
  biquad(s, 'lp', 2600);
  bus.mono(t, s, amp);
}
function keystroke(bus, t, seed, { amp = 0.045 } = {}) {
  const r = rng(seed); const n = Math.ceil(0.03 * SR); const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = (r() * 2 - 1) * Math.exp(-(i / SR) / 0.004);
  biquad(s, 'bp', 2400 + r() * 1800, 1.5);
  bus.mono(t, s, amp * (0.7 + r() * 0.6), (r() - 0.5) * 0.3);
}

function chime(bus, t, m = 81, { amp = 0.12, pan = 0 } = {}) {
  const n = Math.ceil(2.4 * SR); const s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const tt = i / SR; s[i] = (Math.sin(2 * Math.PI * mtof(m) * tt) + 0.5 * Math.sin(2 * Math.PI * mtof(m + 7) * tt) + 0.2 * Math.sin(2 * Math.PI * mtof(m) * 2.76 * tt) * Math.exp(-tt / 0.2)) * Math.exp(-tt / 0.6) * Math.min(1, tt / 0.003); }
  bus.mono(t, s, amp, pan);
}

/** High sustained air: octaves of the key, trembling slightly. */
function shimmer(bus, t, dur, notes, { amp = 0.03 } = {}) {
  const n = Math.ceil((dur + 2) * SR); const L = new Float32Array(n); const R = new Float32Array(n);
  notes.forEach((m, k) => {
    const f = mtof(m);
    for (let i = 0; i < n; i++) {
      const tt = i / SR; const env = Math.min(1, tt / 1.2) * (tt < dur ? 1 : Math.exp(-(tt - dur) / 0.8));
      const v = Math.sin(2 * Math.PI * f * tt + k) * env * (0.7 + 0.3 * Math.sin(tt * (4 + k)));
      L[i] += v * (k % 2 ? 0.6 : 1); R[i] += v * (k % 2 ? 1 : 0.6);
    }
  });
  bus.stereo(t, L, R, amp / notes.length);
}


// ─── New instruments ──────────────────────────────────────────────────────────────────────────────────

/** A two-operator FM voice: an electric piano when the ratio is 1, a bell when it is not a whole number. */
function fm(bus, t, m, { vel = 0.5, dur = 1.6, ratio = 1, index = 2.6, decay = 0.9, pan = 0, tine = 0.25, gain = 0.2 } = {}) {
  const f = mtof(m); const n = Math.ceil(dur * SR); const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt / decay);
    const idx = index * Math.exp(-tt / (decay * 0.45)) * (0.6 + vel * 0.6);
    const mod = Math.sin(2 * Math.PI * f * ratio * tt) * idx + Math.sin(2 * Math.PI * f * 14 * tt) * tine * Math.exp(-tt / 0.03);
    s[i] = Math.sin(2 * Math.PI * f * tt + mod) * env;
  }
  biquad(s, 'hp', 120);
  bus.mono(t, s, vel * gain, pan);
}
const epiano = (bus, t, m, o = {}) => fm(bus, t, m, { ratio: 1, index: 2.2, decay: 0.95, tine: 0.35, gain: 0.16, ...o });
const bell = (bus, t, m, o = {}) => fm(bus, t, m, { ratio: 3.5, index: 3.2, decay: 1.1, tine: 0, dur: 2.4, gain: 0.12, ...o });

/** A synth bass: a saw and its sub, closed down by a short filter envelope. */
function bass(bus, t, m, { dur = 0.4, vel = 0.7 } = {}) {
  const f = mtof(m); const n = Math.ceil((dur + 0.08) * SR); const s = new Float32Array(n);
  let ph = 0; const dt = f / SR;
  for (let i = 0; i < n; i++) {
    const tt = i / SR; ph += dt; if (ph >= 1) ph -= 1;
    const env = Math.min(1, tt / 0.005) * (tt < dur ? 1 : Math.exp(-(tt - dur) / 0.03));
    s[i] = ((2 * ph - 1 - polyblep(ph, dt)) * 0.55 + Math.sin(2 * Math.PI * f * tt) * 0.8) * env;
  }
  biquad(s, 'lp', (i) => 220 + 900 * vel * Math.exp(-i / SR / 0.08), 1.1);
  bus.mono(t, s, vel * 0.32);
}

function clap(bus, t, { amp = 0.18, pan = 0 } = {}) {
  const n = Math.ceil(0.32 * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 1777));
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const burst = [0, 0.009, 0.019].reduce((a, o) => a + (tt >= o ? Math.exp(-(tt - o) / 0.006) : 0), 0) * 0.6 + Math.exp(-tt / 0.09) * 0.5;
    s[i] = (r() * 2 - 1) * burst + Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.04) * 0.25;
  }
  biquad(s, 'bp', 1400, 0.9); biquad(s, 'hp', 500);
  bus.mono(t, s, amp, pan);
}

function hat(bus, t, { amp = 0.05, open = false, pan = 0.2 } = {}) {
  const len = open ? 0.35 : 0.06; const n = Math.ceil(len * SR); const s = new Float32Array(n); const r = rng(Math.round(t * 4099) + (open ? 7 : 0));
  for (let i = 0; i < n; i++) { const tt = i / SR; s[i] = (r() * 2 - 1) * Math.min(1, tt / 0.001) * Math.exp(-tt / (open ? 0.1 : 0.016)); }
  biquad(s, 'hp', 7200, 0.8); biquad(s, 'peak', 10500, 1, 4);
  bus.mono(t, s, amp, pan);
}

/** A clock that has been left running. */
function clockTick(bus, t, hi) { tick(bus, t, { amp: 0.09, pitch: hi ? 3200 : 2500, pan: hi ? 0.15 : -0.15 }); thock(bus, t, { amp: 0.05 }); }

function counterTicks(bus, t0, dur, to, amp = 0.05) {
  let last = -1; let lastT = -1;
  for (let i = 0; i <= dur * 200; i++) {
    const x = i / (dur * 200); const v = Math.floor(to * (1 - (1 - x) ** 3));
    const t = t0 + x * dur;
    if (v !== last && t - lastT > 0.028) { tick(bus, t, { amp, pitch: 2600 + v * 8 }); last = v; lastT = t; }
  }
}

/** The interface's own sounds, read from a take's event log. */
function takeSounds(bus, key, t0, { amp = 1 } = {}) {
  const tk = TAKES[key];
  if (!tk) return;
  let n = 0;
  for (const e of tk.events) {
    const t = t0 + e.t;
    if (e.type === 'click') tick(bus, t, { amp: 0.11 * amp, pan: (e.x / 1440 - 0.5) * 0.6 });
    else if (e.type === 'key') thock(bus, t, { amp: 0.2 * amp });
    else if (e.type === 'char') keystroke(bus, t, ++n * 97 + Math.round(t0 * 10), { amp: 0.04 * amp });
    else if (e.type === 'cut') whoosh(bus, t - 0.12, { dur: 0.5, amp: 0.05 * amp, lo: 600, hi: 2200 });
  }
}

// ─── Harmony ──────────────────────────────────────────────────────────────────────────────────────────

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

/** A chord on a scale degree: root, third, fifth and seventh as pitch classes above the tonic. */
function chordOf(music, degree) {
  const sc = SCALES[music.mode];
  const at = (k) => { const i = degree - 1 + k; return sc[i % 7] + 12 * Math.floor(i / 7); };
  const tones = [at(0), at(2), at(4), at(6)];
  // In a minor key the fifth chord borrows the leading tone, so it pulls home.
  if (music.mode === 'minor' && degree === 5) tones[1] += 1;
  return tones;
}

function voicing(music, degree) {
  const [r, third, fifth, seventh] = chordOf(music, degree);
  const T = music.tonic;
  const root = T + r;
  const bassNote = ((root - 33) % 12 + 12) % 12 + 33;
  const lift = (x) => { let v = T + x; while (v < 55) v += 12; while (v > 66) v -= 12; return v; };
  const pad = [lift(r), lift(third), lift(fifth), lift(seventh) + 12, lift(r) + 12, lift(third) + 12 + (music.mode === 'major' ? 2 : 0)].sort((a, b) => a - b);
  const arp = [lift(r) + 12, lift(third) + 12, lift(fifth) + 12, lift(r) + 24, lift(third) + 24, lift(fifth) + 24].sort((a, b) => a - b);
  const scale = [];
  for (let o = 0; o < 3; o++) for (const x of SCALES[music.mode]) scale.push(T + 12 + x + 12 * o);
  return { bass: bassNote, pad, arp, chordPcs: [r, third, fifth, seventh].map((x) => ((x % 12) + 12) % 12), scale };
}

// ─── Arrangement ──────────────────────────────────────────────────────────────────────────────────────

/** What each scene contributes: how much of the band plays under it. */
function sections(tl) {
  const scenes = tl.scenes;
  const hitIndex = tl.kind === 'chapter' ? 0 : scenes.findIndex((s) => s.cue === 'hit');
  return scenes.map((s, i) => {
    let level;
    if (i === scenes.length - 1) level = 'outro';
    else if (tl.kind === 'chapter') level = i === 0 ? 'intro' : s.cue === 'drop' ? 'break' : i === 1 ? 'low' : 'full';
    else if (i < hitIndex) level = 'dark';
    else if (i === hitIndex) level = 'hit';
    else level = s.cue === 'drop' ? 'break' : 'full';
    return { ...s, level };
  });
}

const GROOVES = {
  four: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [2, 6, 10, 14], shaker: true, bass8: false, pump: 0.55 },
  drive: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], shaker: false, bass8: true, pump: 0.6 },
  half: { kick: [0, 10], clap: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14], shaker: false, bass8: false, pump: 0.35 },
  pulse: { kick: [0, 8], rim: [12], hat: [], shaker: true, bass8: false, pump: 0.3 },
  swing: { kick: [0, 7, 10], rim: [4, 12], hat: [2, 6, 10, 14], swing: true, shaker: false, bass8: false, pump: 0.25 },
  still: { kick: [], rim: [12], hat: [], shaker: true, bass8: false, pump: 0 },
};

function arrange(tl, id) {
  const music = tl.music;
  const T = tl.seconds + 3;
  const B = { pads: new Bus(T), lead: new Bus(T), arp: new Bus(T), bass: new Bus(T), drums: new Bus(T), fx: new Bus(T), ui: new Bus(T) };
  const beat = 60 / music.bpm; const bar = beat * 4; const step = beat / 4;
  const groove = GROOVES[music.groove];
  const rnd = rng(music.seed * 7777);
  const secs = sections(tl);
  const levelAt = (t) => { for (const s of secs) if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s.level; return 'outro'; };
  const firstContent = secs.find((s) => ['low', 'full'].includes(s.level))?.start ?? 0;
  const chordBars = music.groove === 'still' || music.bpm < 86 ? 2 : 1;
  const chordLen = bar * chordBars;
  const degreeAt = (t) => {
    const lv = levelAt(t);
    if (lv === 'intro' || lv === 'outro' || lv === 'hit') return 1;
    const k = Math.floor((t - (lv === 'dark' ? 0 : firstContent) + 1e-6) / chordLen);
    return music.progression[((k % music.progression.length) + music.progression.length) % music.progression.length];
  };
  const kicks = [];

  // Pads and bass, chord by chord.
  const boundaries = new Set([0]);
  for (let t = 0; t < tl.seconds; t += chordLen / (chordBars === 2 ? 2 : 1)) boundaries.add(Number(t.toFixed(4)));
  for (const s of secs) boundaries.add(Number(s.start.toFixed(4)));
  const marks = [...boundaries].sort((a, b) => a - b);
  for (let i = 0; i < marks.length; i++) {
    const t0 = marks[i]; const t1 = i + 1 < marks.length ? marks[i + 1] : tl.seconds;
    if (t1 - t0 < 0.05) continue;
    const lv = levelAt(t0 + 0.01);
    const v = voicing(music, degreeAt(t0 + 0.01));
    const outro = lv === 'outro';
    const pcs = outro && music.mode === 'minor' ? voicing({ ...music, mode: 'major' }, 1).pad : v.pad;
    const bright = lv === 'full' ? [1500, 2300] : lv === 'dark' ? [520, 900] : lv === 'break' ? [800, 1200] : [1100, 1700];
    pad(B.pads, t0, (outro ? tl.seconds - t0 - 0.6 : t1 - t0), pcs, { amp: lv === 'dark' ? 0.085 : 0.09, attack: lv === 'dark' ? 1.8 : 0.5, release: outro ? 2.6 : 1.4, cut: bright, seed: music.seed * 31 + i });
    if (lv !== 'intro' && lv !== 'hit') sub(B.bass, t0, (outro ? tl.seconds - t0 - 0.8 : t1 - t0) - 0.04, v.bass + 12, { amp: lv === 'dark' ? 0.12 : lv === 'break' ? 0.1 : 0.2 });
    if (outro) break;
  }

  // The grid: drums, bass line and the lead, sixteenth by sixteenth.
  const bars = Math.ceil(tl.seconds / bar);
  const motif = Array.from({ length: 8 }, () => rnd());
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < 16; k++) {
      let t = b * bar + k * step;
      if (groove.swing && k % 4 === 2) t += step * 0.33;
      const lv = levelAt(t);
      if (t >= tl.seconds - 0.2) continue;
      const v = voicing(music, degreeAt(t));
      const full = lv === 'full'; const low = lv === 'low';
      // Drums play in full sections; the first content scene gets kick and hats only.
      if (full || low) {
        if (groove.kick.includes(k)) { kick(B.drums, t, { amp: full ? 0.5 : 0.38 }); kicks.push(t); }
        if (full && groove.clap?.includes(k)) clap(B.drums, t, { amp: 0.16 });
        if (full && groove.rim?.includes(k)) rim(B.drums, t, { amp: 0.1 });
        if (groove.hat.includes(k)) hat(B.drums, t, { amp: (k % 4 === 2 ? 0.05 : 0.032) * (full ? 1 : 0.7), pan: 0.25 });
        if (full && groove.hat.length === 8 && k === 14 && b % 2 === 1) hat(B.drums, t, { amp: 0.04, open: true });
        if (groove.shaker && k % 2 === 0) shaker(B.drums, t, { amp: k % 4 === 2 ? 0.03 : 0.018, pan: 0.3 });
        if (groove.bass8 && full && k % 2 === 0) bass(B.bass, t, v.bass + 12 + (k === 14 ? 12 : 0), { dur: step * 1.6, vel: k % 4 === 0 ? 0.75 : 0.55 });
        else if (!groove.bass8 && (full || low) && (k === 0 || (k === 10 && music.groove !== 'still'))) bass(B.bass, t, v.bass + 12, { dur: step * (k === 0 ? 5 : 3), vel: 0.55 });
      }
      if (lv === 'dark' && k === 0 && b % 2 === 0) kicks.push(t);

      // The lead.
      if (!(full || low || lv === 'break')) continue;
      const lead = music.lead;
      if (lead === 'pluck' || lead === 'arp16') {
        const every = lead === 'arp16' ? 1 : 2;
        if (k % every === 0 && (full || k % 4 === 0)) {
          const i = Math.floor(k / every) + b * 3;
          const note = v.arp[[0, 2, 1, 3, 2, 4, 3, 5][i % 8]];
          pluck(B.arp, t, note, { vel: (full ? 0.5 : 0.35) * (k % 4 === 0 ? 1 : 0.8), pan: k % 4 ? 0.35 : -0.35, bright: lv === 'break' ? 0.4 : 0.7 });
        }
      }
      if (lead === 'keys' && (k === 6 || k === 14)) {
        v.pad.slice(0, 4).forEach((m, j) => epiano(B.lead, t + j * 0.006, m, { vel: full ? 0.55 : 0.4, dur: 1.2, pan: (j - 1.5) / 5 }));
      }
      // A short motif on the strong steps, varied every other bar.
      const pattern = [0, 3, 6, 10, 12];
      const melodic = lead === 'piano' || lead === 'bell' || (lead === 'keys' && b % 2 === 1);
      if (melodic && pattern.includes(k) && (full || k === 0 || lv === 'break')) {
        const idx = pattern.indexOf(k);
        if (motif[(idx + (b % 2) * 3) % 8] < 0.3 && k !== 0) continue;
        const chordTone = (m) => v.chordPcs.includes(((m - music.tonic) % 12 + 12) % 12);
        const pool = v.scale.filter((m) => m >= 69 && m <= 88 && (k % 4 === 0 ? chordTone(m) : true));
        const note = pool[Math.floor(motif[(idx * 3 + b) % 8] * pool.length * 0.999)] ?? v.arp[2];
        if (lead === 'bell') bell(B.lead, t, note, { vel: full ? 0.6 : 0.45, pan: (note - 78) / 24 });
        else if (lead === 'keys') epiano(B.lead, t, note + 12, { vel: 0.45, dur: 1.4 });
        else felt(B.lead, t, note, { vel: full ? 0.5 : 0.42, dur: 3.5, pan: (note - 78) / 24 });
      }
    }
  }
  if (music.lead === 'pluck' || music.lead === 'arp16') pingpong(B.arp, beat * 0.75, 0.3, 0.26);
  if (music.lead === 'bell' || music.lead === 'piano') pingpong(B.lead, beat * 0.5, 0.22, 0.14);

  // Cues: what happens at the start of a scene.
  for (const [i, s] of secs.entries()) {
    if (i > 0 && s.level !== 'outro') whoosh(B.fx, s.start - 0.3, { dur: 0.55, amp: 0.045, lo: 700, hi: 2800 });
    if (s.cue === 'lift') { riser(B.fx, s.start - bar, bar, { amp: 0.09 }); shimmer(B.pads, s.start, bar * 2, [voicing(music, 1).arp[3], voicing(music, 1).arp[5]], { amp: 0.03 }); }
    if (s.cue === 'build') riser(B.fx, s.start, s.end - s.start, { amp: 0.06 });
  }
  const first = secs[0];
  if (tl.kind === 'chapter') {
    impact(B.fx, first.start + 0.12, { amp: 0.22, size: 0.7 });
    voicing(music, 1).pad.forEach((m, j) => felt(B.lead, first.start + 0.12 + j * 0.045, m, { vel: 0.5, dur: 5, pan: (j - 2.5) / 5 }));
    shimmer(B.pads, first.start, 3, [voicing(music, 1).arp[3], voicing(music, 1).arp[5]], { amp: 0.03 });
  }
  const hit = secs.find((s) => s.level === 'hit');
  if (hit) {
    riser(B.fx, hit.start - 2.2, 2.2, { amp: 0.18 });
    impact(B.fx, hit.start, { amp: 0.9, size: 1.2 });
    shimmer(B.pads, hit.start, hit.end - hit.start + 1, voicing(music, 1).arp.slice(2), { amp: 0.05 });
    voicing(music, 1).pad.forEach((m, j) => felt(B.lead, hit.start + 0.02 + j * 0.03, m, { vel: 0.6, dur: 5, pan: (j - 2.5) / 5 }));
  }
  const end = secs[secs.length - 1];
  impact(B.fx, end.start + 0.1, { amp: tl.kind === 'chapter' ? 0.2 : 0.35, size: 0.9 });
  const home = voicing({ ...music, mode: 'major' }, 1).pad;
  home.forEach((m, j) => felt(B.lead, end.start + 0.12 + j * 0.05, m, { vel: 0.5, dur: 6, pan: (j - 2.5) / 5 }));
  shimmer(B.pads, end.start, end.end - end.start - 0.5, voicing(music, 1).arp.slice(3), { amp: 0.04 });

  // The dark opening of the ad and the tour: sparse piano over the pad.
  for (const s of secs.filter((x) => x.level === 'dark')) {
    const v = voicing(music, 1);
    for (let t = s.start + 0.4, j = 0; t < s.end - 0.6; t += beat * 2, j++) felt(B.lead, t, v.arp[[2, 1, 3, 0][j % 4]], { vel: 0.38, dur: 4, pan: j % 2 ? 0.3 : -0.3 });
  }

  // The product's own sounds.
  for (const s of tl.scenes) takeSounds(B.ui, `${id}/${s.id}`, s.start, { amp: 1 });
  for (const s of tl.scenes) if (id === 'ad' && (s.id === 'ad-capture' || s.id === 'ad-queue')) takeSounds(B.ui, `ad/${s.id}`, s.start, { amp: 1 });
  if (id === 'hero') for (const k of ['capture', 'queue']) { const s = tl.scenes.find((x) => x.id === k); if (s) takeSounds(B.ui, `hero/${k}`, s.start, { amp: 1 }); }
  designedSounds(B, tl, id);

  return { B, T, kicks, pump: groove.pump, beat };
}

/** Sounds for the designed scenes of the ad and the tour, from the same moments the picture uses. */
function designedSounds(B, tl, id) {
  if (id !== 'ad' && id !== 'hero') return;
  const sc = (x) => tl.scenes.find((s) => s.id === x);
  const counterScene = sc(id === 'ad' ? 'ad-work' : 'detail');
  if (counterScene) counterTicks(B.fx, counterScene.start + MOMENTS.counter.at, MOMENTS.counter.dur, 30, 0.05);
  const gapScene = sc(id === 'ad' ? 'ad-gap' : 'detail');
  if (gapScene) { const stamp = gapScene.start + (gapScene.end - gapScene.start) * MOMENTS.gap.stamp; thock(B.fx, stamp, { amp: 0.25 }); chime(B.fx, stamp + 0.05, 81, { amp: 0.09, pan: 0.3 }); }
  const later = sc('ad-later');
  if (later) for (let i = 0; i < MOMENTS.months.count; i++) clockTick(B.fx, later.start + MOMENTS.months.at + i * MOMENTS.months.step, i % 2 === 0);
  const scatter = sc(id === 'ad' ? 'ad-scatter' : 'scatter');
  if (scatter) {
    for (let k = 0; k < 3; k++) whoosh(B.fx, scatter.start + MOMENTS.scatter.first + k * MOMENTS.scatter.step - 0.35, { dur: 0.75, amp: 0.13, from: [-0.8, 0, 0.8][k] - 0.3, to: [-0.8, 0, 0.8][k] + 0.3, lo: 300, hi: 2400 });
    for (let i = 0; i < 50; i++) { const r = rng(i + 5); tick(B.fx, scatter.end - 1.4 + r() * 1.2, { amp: 0.015 + r() * 0.015, pitch: 3000 + r() * 3000, pan: r() * 1.6 - 0.8 }); }
  }
  const history = sc(id === 'ad' ? 'ad-history' : 'sealed');
  if (history) {
    const d = history.end - history.start;
    for (let i = 0; i < 6; i++) tick(B.fx, history.start + MOMENTS.history.first + i * MOMENTS.history.step, { amp: 0.07, pitch: 1900 + i * 120 });
    thock(B.fx, history.start + d * MOMENTS.history.seal, { amp: 0.24 }); chime(B.fx, history.start + d * MOMENTS.history.seal + 0.04, 86, { amp: 0.06 });
  }
  const report = sc(id === 'ad' ? 'ad-report' : 'report');
  if (report) {
    const d = report.end - report.start;
    for (let i = 0; i < 70; i++) keystroke(B.ui, report.start + MOMENTS.report.type + (i / 70) * d * 0.28, i * 13, { amp: 0.03 });
    chime(B.fx, report.start + d * MOMENTS.report.cite, 84, { amp: 0.06, pan: 0.4 }); chime(B.fx, report.start + d * MOMENTS.report.cite + 0.27, 88, { amp: 0.05, pan: 0.5 });
  }
}

function writeWav(path, L, R) {
  const n = L.length; const buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], 44 + i * 8); buf.writeFloatLE(R[i], 48 + i * 8); }
  writeFileSync(path, buf);
}

function loudnorm(input, output, target) {
  const pass1 = spawnSync(FFMPEG, ['-hide_banner', '-i', input, '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'], { env: ENV, encoding: 'utf8' });
  const m = pass1.stderr.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`loudnorm measure: ${pass1.stderr.slice(-400)}`);
  const j = JSON.parse(m[0]);
  const af = `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-af', af, '-ar', String(SR), '-c:a', 'pcm_s24le', output], { env: ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`loudnorm: ${r.stderr}`);
  return { measured: Number(j.input_i) };
}

export function score(id) {
  const tl = TL[id];
  const { B, T, kicks, pump } = arrange(tl, id);
  // The pads, bass and arpeggio breathe with the kick.
  const duck = new Float32Array(Math.ceil(T * SR)).fill(1);
  if (pump > 0) for (const k of kicks) {
    const o = Math.round(k * SR); const len = Math.round(0.28 * SR);
    for (let i = 0; i < len && o + i < duck.length; i++) { const x = i / len; duck[o + i] = Math.min(duck[o + i], 1 - pump * 0.45 * (1 - x) ** 2); }
  }
  const send = new Bus(T);
  for (let i = 0; i < send.n; i++) {
    send.L[i] = B.pads.L[i] * 0.5 + B.lead.L[i] * 0.55 + B.arp.L[i] * 0.4 + B.fx.L[i] * 0.45 + B.drums.L[i] * 0.08 + B.ui.L[i] * 0.2;
    send.R[i] = B.pads.R[i] * 0.5 + B.lead.R[i] * 0.55 + B.arp.R[i] * 0.4 + B.fx.R[i] * 0.45 + B.drums.R[i] * 0.08 + B.ui.R[i] * 0.2;
  }
  const hall = reverb(send, { room: 0.86, damp: 0.34, pre: 0.025 });
  const mix = new Bus(T);
  const n = Math.round(tl.seconds * SR);
  const fadeIn = Math.round(0.02 * SR); const fadeOutFrom = Math.round((tl.seconds - 0.6) * SR);
  for (let i = 0; i < mix.n; i++) {
    const d = duck[i] ?? 1;
    const l = (B.pads.L[i] + B.bass.L[i] + B.arp.L[i]) * d + B.lead.L[i] + B.drums.L[i] * 0.9 + B.fx.L[i] + B.ui.L[i] * 0.8 + hall.L[i] * 0.85;
    const r = (B.pads.R[i] + B.bass.R[i] + B.arp.R[i]) * d + B.lead.R[i] + B.drums.R[i] * 0.9 + B.fx.R[i] + B.ui.R[i] * 0.8 + hall.R[i] * 0.85;
    const g = Math.min(1, i / fadeIn) * (i > fadeOutFrom ? Math.max(0, 1 - (i - fadeOutFrom) / (0.6 * SR)) : 1);
    mix.L[i] = Math.tanh(l * g * 1.15) / 1.15; mix.R[i] = Math.tanh(r * g * 1.15) / 1.15;
  }
  mkdirSync(join(ROOT, '.work'), { recursive: true });
  mkdirSync(join(ROOT, 'public', 'mix'), { recursive: true });
  const raw = join(ROOT, '.work', `mix-${id}.wav`);
  writeWav(raw, mix.L.subarray(0, n), mix.R.subarray(0, n));
  const out = join(ROOT, 'public', 'mix', `${id}.wav`);
  const { measured } = loudnorm(raw, out, tl.kind === 'chapter' ? -16 : -14);
  const mediaPath = join(ROOT, 'src', 'generated', 'media.json');
  const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')) : { mixes: {} };
  media.mixes[id] = { file: `mix/${id}.wav` };
  writeFileSync(mediaPath, JSON.stringify(media, null, 1));
  const m = tl.music;
  return { id, seconds: tl.seconds, measured, style: `${['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][m.tonic % 12]} ${m.mode}, ${m.bpm} bpm, ${m.groove}, ${m.lead}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = process.argv.slice(2);
  for (const id of Object.keys(TL)) {
    if (want.length && !want.includes(id)) continue;
    const t0 = Date.now();
    const r = score(id);
    console.log(`score: ${id.padEnd(18)} ${r.seconds.toFixed(1)}s  ${r.style}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
