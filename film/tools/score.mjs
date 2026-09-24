/**
 * The score and the sound, made in code, and the final mix with the narration.
 *
 *   node tools/score.mjs            every film
 *   node tools/score.mjs hero       one
 *
 * Everything is synthesised here — pads, a felt piano, plucked arpeggios, sub bass, a kick, impacts,
 * risers, whooshes and the interface's own clicks — and arranged against the same timeline as the
 * picture: the hit lands on the title, the music lifts where the script says "lift", and every
 * click in the footage has its tick. Nothing is sampled, so nothing is licensed.
 *
 * The narration (assets/vo, from tools/voice.mjs) sits on top; the music ducks under it. The mix is
 * loudness-normalised to −14 LUFS, −1.5 dBTP, for the web, and written to public/mix/<film>.wav.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FF_DIR = join(ROOT, 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
const FFMPEG = join(FF_DIR, 'ffmpeg');
const ENV = { ...process.env, LD_LIBRARY_PATH: FF_DIR };
const SR = 48000;
const TL = JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'timelines.json'), 'utf8'));
const TAKES = existsSync(join(ROOT, 'src', 'generated', 'takes.json')) ? JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'takes.json'), 'utf8')) : {};

/* ── primitives ──────────────────────────────────────────────────────────────────────────────── */

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const cents = (c) => 2 ** (c / 1200);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pan2 = (pan) => { const th = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4; return [Math.cos(th), Math.sin(th)]; };
const db = (d) => 10 ** (d / 20);

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

/** RBJ biquad, processed in place; `fc` may be a function of the sample index (updated every 32). */
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

/** Freeverb: eight combs and four allpasses a side, with a little pre-delay. */
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

/* ── instruments ─────────────────────────────────────────────────────────────────────────────── */

/** A pad: three detuned saws a note, a slow filter, a soft attack and a long release. */
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

/** A felt piano: inharmonic partials with their own decays, a soft hammer, darker when quiet. */
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

/** A build into a moment: noise opening upward, and a tone climbing under it. */
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

/** The interface: a soft tick for a click, a rounder one for a key, a whisper for each character. */
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

/** A small bright bell: two sines a fifth apart. For things that come right. */
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

/* ── harmony ─────────────────────────────────────────────────────────────────────────────────── */

const CHORDS = {
  Dm: { root: 38, pad: [57, 62, 65, 69, 76], arp: [62, 65, 69, 74, 76, 81] },
  Bb: { root: 34, pad: [58, 62, 65, 69, 74], arp: [58, 62, 65, 69, 74, 77] },
  F: { root: 41, pad: [57, 60, 65, 67, 72], arp: [60, 65, 67, 69, 72, 77] },
  C: { root: 36, pad: [55, 60, 62, 67, 72], arp: [60, 62, 67, 72, 74, 79] },
  D: { root: 38, pad: [57, 62, 66, 69, 76], arp: [62, 66, 69, 74, 76, 81] },
};
const PROG = ['Dm', 'Bb', 'F', 'C'];
const ARP = [0, 2, 1, 3, 2, 4, 3, 5];

/* ── the films ───────────────────────────────────────────────────────────────────────────────── */

function clock(tl) {
  const sc = (id) => tl.scenes.find((s) => s.id === id);
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}$]/gu, '');
  return {
    start: (id) => sc(id).start, end: (id) => sc(id).end,
    w: (id, word, nth = 0) => { const ws = sc(id).lines.flatMap((l) => l.words).filter((x) => norm(x.word) === norm(word)); return (ws[nth] ?? ws[0] ?? { start: sc(id).start }).start; },
    line: (id, i) => sc(id).lines[i],
  };
}

/** Ticks as a counter rolls from 0 to `to` over `dur`, eased out: fast, then slowing. */
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

function heroScore(tl) {
  const c = clock(tl); const T = tl.seconds + 1;
  const music = new Bus(T); const drums = new Bus(T); const fx = new Bus(T); const arpBus = new Bus(T);
  const title = c.start('title'); const cap = c.start('capture'); const trust = c.start('trust'); const end = c.start('end');
  const beat = 60 / tl.score.bpm; const bar = beat * 4; const chordLen = bar * 2;

  // Before the title: one low chord in the dark, opening a little, closing again when the work is lost.
  const gone = c.w('scatter', 'gone');
  pad(music, 0, title - 0.2, [50, 53, 57, 62, 69], { amp: 0.1, attack: 3.5, release: 1.2, cut: [500, 1100], seed: 3 });
  pad(music, 0, title - 0.2, [50, 57], { amp: 0.03, attack: 4, release: 1, cut: [300, 380], seed: 4 });
  for (const [t, m, v] of [[1.4, 74, 0.45], [3.9, 69, 0.4], [6.1, 77, 0.42], [c.start('detail') + 0.3, 76, 0.5], [c.w('detail', 'caught') - 0.05, 81, 0.5], [gone + 0.1, 77, 0.35], [gone + 1.0, 76, 0.32], [gone + 2.0, 74, 0.3]]) felt(music, t, m, { vel: v, dur: 5, pan: (m - 74) / 20 });
  counterTicks(fx, c.w('detail', 'thirty') - 0.13, 0.73, 30, 0.045);
  chime(fx, c.w('detail', 'caught') + 0.08, 81, { amp: 0.08, pan: 0.3 });
  // The work coming apart, and the three places it goes.
  for (let i = 0; i < 70; i++) { const r = rng(i + 5); tick(fx, gone - 0.2 + r() * 1.6 * r(), { amp: 0.018 + r() * 0.02, pitch: 3000 + r() * 3000, pan: r() * 1.6 - 0.8 }); }
  whoosh(fx, gone - 0.4, { dur: 1.3, amp: 0.1, from: 0.2, to: -0.4, lo: 250, hi: 1800 });
  ['spreadsheet', 'inbox', 'memory'].forEach((w, k) => whoosh(fx, c.w('scatter', w) - 0.45, { dur: 0.75, amp: 0.13, from: [-0.8, 0, 0.8][k] - 0.3, to: [-0.8, 0, 0.8][k] + 0.3, lo: 300, hi: 2400 }));
  riser(fx, title - 2.4, 2.4, { amp: 0.2 });

  // The title: the hit, and air.
  impact(fx, title, { amp: 0.9, size: 1.2 });
  shimmer(music, title, 5, [74, 81, 86, 93], { amp: 0.05 });

  // From the title: the progression, and the groove from the capture on.
  let k = 0;
  for (let t = title; t < trust; t += chordLen, k++) {
    const ch = CHORDS[PROG[k % 4]];
    const len = Math.min(chordLen, trust - t);
    const lift = t >= c.start('credit') - 0.1 ? 1 : 0;
    pad(music, t, len, ch.pad, { amp: 0.1, attack: 0.9, release: 2.4, cut: [1500 + lift * 800, 2200 + lift * 1000], seed: 10 + k });
    if (lift && t < c.end('lead')) pad(music, t, len, ch.pad.map((m) => m + 12), { amp: 0.03, attack: 1.5, release: 2, cut: [2200, 3200], seed: 50 + k, spread: 1 });
    if (t + 0.01 >= cap - 0.01 || t + len > cap) {
      const s0 = Math.max(t, cap);
      sub(music, s0, t + len - s0 - 0.05, ch.root + 12, { amp: 0.26 });
    }
  }
  // The groove: a grid from the title's downbeat.
  const balance = c.start('balance'); const sealed = c.start('sealed'); const credit = c.start('credit');
  for (let t = title; t < trust - 0.05; t += beat / 2) {
    const i = Math.round((t - title) / (beat / 2));
    if (t < cap - 0.02) continue;
    const ch = CHORDS[PROG[Math.floor((t - title) / chordLen) % 4]];
    const inBuild = t >= balance && t < sealed;
    const vel = t < c.start('queue') ? 0.55 : inBuild ? 0.55 + 0.4 * ((t - balance) / (sealed - balance)) : 0.7;
    pluck(arpBus, t, ch.arp[ARP[i % 8]], { vel, pan: i % 2 ? 0.35 : -0.35, bright: inBuild ? 0.6 + (t - balance) / (sealed - balance) : 0.8 });
    if (inBuild) pluck(arpBus, t + beat / 4, ch.arp[ARP[(i + 3) % 8]] + 12, { vel: vel * 0.6, pan: i % 2 ? -0.5 : 0.5, bright: 0.9 });
    if (i % 4 === 0) kick(drums, t, { amp: t < credit ? 0.42 : 0.5 });
    if (t >= c.start('queue')) { shaker(drums, t, { amp: i % 2 ? 0.035 : 0.022, pan: 0.3 }); shaker(drums, t + beat / 4, { amp: 0.016, pan: 0.35 }); }
    if (i % 4 === 2 && t >= credit && t < c.end('lead')) rim(drums, t, { amp: 0.1 });
  }
  pingpong(arpBus, beat * 0.75, 0.33, 0.3);
  // Lifts and the build.
  for (const id of ['capture', 'credit']) { const t = c.start(id); whoosh(fx, t - 1.1, { dur: 1.3, amp: 0.12, lo: 500, hi: 5200, from: -0.5, to: 0.5 }); shimmer(music, t, 3, [81, 86, 88], { amp: 0.035 }); }
  riser(fx, balance, sealed - balance, { amp: 0.12 });
  impact(fx, sealed, { amp: 0.35, size: 0.6 });

  // Picture sounds.
  takeSounds(fx, 'hero/capture', cap, { amp: 0.9 });
  takeSounds(fx, 'hero/queue', c.start('queue'), { amp: 0.9 });
  tick(fx, c.w('case', 'evidence') + 0.05, { amp: 0.1, pitch: 1400 });
  chime(fx, c.w('case', 'verified') + 0.1, 81, { amp: 0.1 });
  felt(fx, c.w('balance', 'commitments') + 0.05, 69, { vel: 0.5, dur: 2 });
  felt(fx, c.w('balance', 'undelivered') + 0.05, 72, { vel: 0.5, dur: 2 });
  [74, 77, 81, 86].forEach((m, i) => felt(fx, c.w('balance', 'order') + i * 0.38, m, { vel: 0.45, dur: 2.5, pan: -0.3 + i * 0.2 }));
  const l0 = c.line('sealed', 0); const nothing = c.w('sealed', 'nothing');
  const step = Math.max(8, Math.min(16, ((nothing - l0.start) * 30 - 14) / 6)) / 30;
  for (let i = 0; i < 6; i++) tick(fx, l0.start - 4 / 30 + i * step + 0.12, { amp: 0.08, pitch: 1900 + i * 120 });
  thock(fx, nothing - 0.1, { amp: 0.26 }); chime(fx, nothing - 0.05, 86, { amp: 0.06 });
  counterTicks(fx, c.w('credit', 'credit') - 2 / 30, 1.0, 66, 0.035);
  const written = c.w('report', 'written'); const cites = c.w('report', 'cites');
  for (let i = 0; i < 86; i++) keystroke(fx, written - 20 / 30 + (i / 86) * 2.0, i * 13, { amp: 0.035 });
  chime(fx, cites + 0.05, 84, { amp: 0.06, pan: 0.4 }); chime(fx, cites + 0.32, 88, { amp: 0.05, pan: 0.5 });
  whoosh(fx, c.start('lead') + 0.2, { dur: 1.6, amp: 0.1, lo: 400, hi: 3000, from: -0.8, to: 0.8 });
  for (const id of ['queue', 'case', 'balance', 'report', 'lead']) whoosh(fx, c.start(id) - 0.25, { dur: 0.5, amp: 0.05, lo: 700, hi: 2600 });

  // Trust: everything falls away but the pad and the piano.
  pad(music, trust, end - trust, CHORDS.Bb.pad, { amp: 0.08, attack: 0.6, release: 1.5, cut: [1200, 800], seed: 90 });
  felt(music, trust + 0.4, 74, { vel: 0.4, dur: 5 }); felt(music, trust + 2.2, 81, { vel: 0.32, dur: 5, pan: 0.3 });
  pad(music, trust, end - trust + 1, [38, 45], { amp: 0.025, attack: 1.5, release: 1, cut: [260, 260], seed: 91 });

  // The end: resolve to the major, and let it ring out.
  const res = end + 0.25;
  impact(fx, res, { amp: 0.35, size: 0.9 });
  pad(music, res, tl.seconds - res - 1.2, CHORDS.D.pad, { amp: 0.11, attack: 0.5, release: 2.6, cut: [3200, 1600], seed: 99 });
  pad(music, res, tl.seconds - res - 1.2, [50, 57], { amp: 0.035, attack: 0.3, release: 2.4, cut: [400, 300], seed: 98 });
  [50, 57, 62, 66, 69, 74].forEach((m, i) => felt(music, res + i * 0.06, m, { vel: 0.55, dur: 6, pan: (i - 2.5) / 4 }));
  shimmer(music, res, tl.seconds - res - 1, [78, 81, 86, 90], { amp: 0.05 });

  return { music, drums, fx, arpBus, T };
}

function chapterScore(tl, id) {
  const T = tl.seconds + 1; const c = clock(tl);
  const music = new Bus(T); const drums = new Bus(T); const fx = new Bus(T); const arpBus = new Bus(T);
  const beat = 60 / tl.score.bpm; const chordLen = beat * 8;
  const [first, ...shots] = tl.scenes;
  const endAt = tl.seconds - 64 / 30;
  // The title: a soft struck chord, a little air.
  const t0 = first.start + 0.15;
  impact(fx, t0, { amp: 0.22, size: 0.7 });
  [50, 57, 62, 65, 69].forEach((m, i) => felt(music, t0 + i * 0.05, m, { vel: 0.5, dur: 5, pan: (i - 2) / 4 }));
  shimmer(music, t0, 3, [81, 86], { amp: 0.03 });
  // The bed: the hero's progression, quieter and darker, with a gentle arpeggio.
  const start = shots[0].start;
  let k = 0;
  for (let t = start; t < endAt; t += chordLen, k++) {
    const ch = CHORDS[PROG[k % 4]];
    const len = Math.min(chordLen, endAt - t);
    pad(music, t, len, ch.pad, { amp: 0.075, attack: 1.2, release: 2.4, cut: [1200, 1700], seed: 200 + k });
    sub(music, t, len - 0.05, ch.root + 12, { amp: 0.12 });
  }
  for (let t = start + beat, i = 0; t < endAt - beat; t += beat / 2, i++) {
    const ch = CHORDS[PROG[Math.floor((t - start) / chordLen) % 4]];
    pluck(arpBus, t, ch.arp[ARP[i % 8]], { vel: 0.35, pan: i % 2 ? 0.35 : -0.35, bright: 0.5 });
  }
  pingpong(arpBus, beat * 0.75, 0.3, 0.25);
  // The product's own sounds.
  for (const s of shots) takeSounds(fx, `${id}/${s.id}`, s.start, { amp: 1 });
  whoosh(fx, start - 0.35, { dur: 0.8, amp: 0.08, lo: 400, hi: 2600 });
  // Resolve on the end card.
  impact(fx, endAt + 0.2, { amp: 0.18, size: 0.7 });
  pad(music, endAt, tl.seconds - endAt - 0.5, CHORDS.D.pad, { amp: 0.09, attack: 0.4, release: 1.6, cut: [2800, 1500], seed: 299 });
  [50, 57, 62, 66, 69].forEach((m, i) => felt(music, endAt + 0.2 + i * 0.05, m, { vel: 0.5, dur: 4, pan: (i - 2) / 4 }));
  return { music, drums, fx, arpBus, T, c };
}

/* ── narration, ducking, mix ─────────────────────────────────────────────────────────────────── */

/** Any audio file → mono float samples at SR (through a 24-bit WAV: this ffmpeg has no raw or float PCM output). */
export function decode(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s24le', '-f', 'wav', '-'], { env: ENV, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`decode ${file}: ${r.stderr}`);
  const b = r.stdout;
  let o = 12;
  while (o < b.length - 8) {
    const id = b.toString('ascii', o, o + 4); const size = b.readUInt32LE(o + 4);
    if (id === 'data') {
      const len = Math.min(size === 0xffffffff || size === 0 ? b.length - o - 8 : size, b.length - o - 8);
      const out = new Float32Array(Math.floor(len / 3));
      for (let i = 0; i < out.length; i++) out[i] = b.readIntLE(o + 8 + i * 3, 3) / 8388608;
      return out;
    }
    o += 8 + size + (size & 1);
  }
  throw new Error(`decode ${file}: no data chunk`);
}

function voiceBus(tl, T) {
  const vo = new Bus(T); let lines = 0;
  for (const s of tl.scenes) for (const l of s.lines) {
    if (!l.file) continue;
    const sig = decode(join(ROOT, 'assets', l.file));
    biquad(sig, 'hp', 75, 0.7);
    biquad(sig, 'peak', 3200, 0.8, 1.5);
    vo.mono(l.start, sig, 1, 0);
    lines++;
  }
  return { vo, lines };
}

/** How much to pull the music down at each sample: follows the voice with a fast attack, slow release. */
function duckCurve(vo, depthDb = -7) {
  const g = new Float32Array(vo.n);
  const a = Math.exp(-1 / (0.012 * SR)); const r = Math.exp(-1 / (0.45 * SR));
  let env = 0; const depth = db(depthDb);
  for (let i = 0; i < vo.n; i++) {
    const x = Math.abs(vo.L[i]) + Math.abs(vo.R[i]);
    env = x > env ? a * env + (1 - a) * x : r * env + (1 - r) * x;
    const k = clamp(env / 0.05, 0, 1);
    g[i] = 1 - (1 - depth) * k;
  }
  // Smooth the gain itself so it never flutters.
  let s = 1; const sm = Math.exp(-1 / (0.03 * SR));
  for (let i = 0; i < g.length; i++) { s = sm * s + (1 - sm) * g[i]; g[i] = s; }
  return g;
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
  const parts = id === 'hero' ? heroScore(tl) : chapterScore(tl, id);
  const { music, drums, fx, arpBus, T } = parts;
  const { vo, lines } = voiceBus(tl, T);
  const duck = lines ? duckCurve(vo, id === 'hero' ? -7 : -9) : null;

  // Room: the music and the effects share one hall; the arpeggio gets its own brighter send.
  const send = new Bus(T);
  for (let i = 0; i < send.n; i++) {
    send.L[i] = music.L[i] * 0.55 + fx.L[i] * 0.45 + arpBus.L[i] * 0.4 + drums.L[i] * 0.12;
    send.R[i] = music.R[i] * 0.55 + fx.R[i] * 0.45 + arpBus.R[i] * 0.4 + drums.R[i] * 0.12;
  }
  const hall = reverb(send, { room: 0.87, damp: 0.35, pre: 0.025 });
  const mix = new Bus(T);
  const fadeIn = Math.round(0.02 * SR); const fadeOutFrom = Math.round((tl.seconds - 0.25) * SR);
  for (let i = 0; i < mix.n; i++) {
    const d = duck ? duck[i] : 1;
    const dFx = duck ? 1 - (1 - duck[i]) * 0.5 : 1;
    let l = (music.L[i] + arpBus.L[i] + drums.L[i] + hall.L[i] * 0.9) * d + fx.L[i] * dFx + vo.L[i] * 0.9;
    let r = (music.R[i] + arpBus.R[i] + drums.R[i] + hall.R[i] * 0.9) * d + fx.R[i] * dFx + vo.R[i] * 0.9;
    const g = Math.min(1, i / fadeIn) * (i > fadeOutFrom ? Math.max(0, 1 - (i - fadeOutFrom) / (0.25 * SR)) : 1);
    // A soft ceiling before the loudness pass: gentle saturation instead of hard clipping.
    mix.L[i] = Math.tanh(l * g * 1.1) / 1.1; mix.R[i] = Math.tanh(r * g * 1.1) / 1.1;
  }
  const n = Math.round(tl.seconds * SR);
  mkdirSync(join(ROOT, '.work'), { recursive: true });
  mkdirSync(join(ROOT, 'public', 'mix'), { recursive: true });
  const raw = join(ROOT, '.work', `mix-${id}.wav`);
  writeWav(raw, mix.L.subarray(0, n), mix.R.subarray(0, n));
  // Without the voice this is a music preview: leave it quieter so it is not mistaken for a final mix.
  const out = join(ROOT, 'public', 'mix', `${id}.wav`);
  const { measured } = loudnorm(raw, out, lines ? -14 : -18);
  // Tell the compositions which films have a mix to play, and whether it carries the voice.
  const mediaPath = join(ROOT, 'src', 'generated', 'media.json');
  const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')) : { mixes: {} };
  media.mixes[id] = { file: `mix/${id}.wav`, voiced: lines };
  writeFileSync(mediaPath, JSON.stringify(media, null, 1));
  return { id, seconds: tl.seconds, voiced: lines, measured };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = process.argv.slice(2);
  for (const id of Object.keys(TL)) {
    if (want.length && !want.includes(id)) continue;
    const t0 = Date.now();
    const r = score(id);
    console.log(`score: ${id.padEnd(18)} ${r.seconds.toFixed(1)}s  ${r.voiced ? `${r.voiced} lines voiced` : 'music only (no voice yet)'}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
