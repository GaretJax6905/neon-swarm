/* Neon Swarm: canvas game client.
 *
 * Performance notes (why it stays smooth on phones):
 *  - No shadowBlur. Glows are pre-rendered sprites drawn with additive blending.
 *  - Particles, bullets and XP shards live in typed arrays (no garbage per frame).
 *  - Same-colored shapes are batched into one path and stroked once.
 *  - Collisions use a spatial grid, not every-bullet-vs-every-enemy.
 *  - "Auto" graphics drops resolution and effects if frames start running long.
 */
"use strict";

(() => {
  const CONFIG = JSON.parse(document.getElementById("config").textContent);
  const ENEMY = CONFIG.enemies;
  const UPG = CONFIG.upgrades;
  const XP_TABLE = CONFIG.xp_table;

  const $ = (sel) => document.querySelector(sel);
  const TAU = Math.PI * 2;
  const ARENA = 1600;
  const VIEW_MIN = 680; // world units visible across the short side of the screen

  // ---------- server API (window.NEON_API lets a static preview swap it) ----------
  const api = window.NEON_API || {
    async run(daily) {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily }),
      });
      if (!res.ok) throw new Error("Could not start a run.");
      return res.json();
    },
    async wave(seed, n) {
      const res = await fetch(`/api/wave?seed=${encodeURIComponent(seed)}&n=${n}`);
      if (!res.ok) throw new Error("Could not load the next wave.");
      return res.json();
    },
  };

  // ---------- small helpers ----------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode: settings just won't persist */
      }
    },
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmt = (n) => Math.floor(n).toLocaleString("en-US");

  // ---------- colors ----------
  const COLORS = ["#ffffff", "#33f0ff", "#ffe14d", "#ff4fd8", "#ff9cf0", "#9d6bff", "#ff7a2f", "#7cff6b", "#ff3b5c"];
  const C = { white: 0, cyan: 1, yellow: 2, pink: 3, lpink: 4, purple: 5, orange: 6, green: 7, red: 8 };
  const KIND_COLOR = {};
  for (const [kind, info] of Object.entries(ENEMY)) KIND_COLOR[kind] = Math.max(0, COLORS.indexOf(info.color));

  // ---------- quality ----------
  const QUALITY = [
    { name: "Low", dpr: 1, particles: 0.35, grid: false, stars: 1 },
    { name: "Medium", dpr: 1.5, particles: 0.65, grid: true, stars: 1 },
    { name: "High", dpr: 2, particles: 1, grid: true, stars: 2 },
  ];
  const settings = { quality: store.get("neon-swarm:quality", "auto"), shake: store.get("neon-swarm:shake", true), muted: store.get("neon-swarm:muted", false), music: store.get("neon-swarm:music", true), fps: false };
  let qLevel = settings.quality === "auto" ? 2 : Number(settings.quality);
  let q = QUALITY[qLevel];

  // ---------- canvas ----------
  const canvas = $("#game");
  const ctx = canvas.getContext("2d", { alpha: false });
  let vw = 0;
  let vh = 0;
  let dpr = 1;
  let scale = 1;
  let vignette = null;

  function resize() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    scale = Math.min(vw, vh) / VIEW_MIN;
    vignette = makeVignette();
  }

  function offscreen(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  function makeVignette() {
    const c = offscreen(256, 256);
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 128, 60, 128, 128, 182);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.65)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    return c;
  }

  // Pre-rendered glow sprites: one radial gradient per color, reused everywhere.
  const glowCache = new Map();
  function glow(colorIndex) {
    let sprite = glowCache.get(colorIndex);
    if (!sprite) {
      sprite = offscreen(128, 128);
      const g = sprite.getContext("2d");
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      const hex = COLORS[colorIndex];
      grad.addColorStop(0, hex + "ff");
      grad.addColorStop(0.22, hex + "88");
      grad.addColorStop(0.55, hex + "26");
      grad.addColorStop(1, hex + "00");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      glowCache.set(colorIndex, sprite);
    }
    return sprite;
  }

  function drawGlow(colorIndex, x, y, radius, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(glow(colorIndex), x - radius, y - radius, radius * 2, radius * 2);
  }

  // Starfield tiles for parallax (drawn once, then just blitted).
  const starTiles = [0, 1].map((layer) => {
    const size = 1024;
    const c = offscreen(size, size);
    const g = c.getContext("2d");
    const count = layer ? 70 : 160;
    for (let i = 0; i < count; i++) {
      const r = layer ? rand(1, 2.2) : rand(0.4, 1.2);
      g.fillStyle = `hsla(${rand(180, 320)},100%,${rand(70, 95)}%,${rand(0.25, 0.9)})`;
      g.beginPath();
      g.arc(Math.random() * size, Math.random() * size, r, 0, TAU);
      g.fill();
    }
    return c;
  });

  // ---------- audio (tiny synth, no files) ----------
  const sfx = (() => {
    let ac = null;
    let master = null;
    let lastPickup = 0;
    function ensure() {
      if (ac) return ac;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ac = new Ctor();
      master = ac.createGain();
      master.gain.value = 0.35;
      master.connect(ac.destination);
      return ac;
    }
    function tone(freq, dur, type = "square", vol = 0.2, slide = 0) {
      if (settings.muted || settings.sfxOff || !ensure()) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    function noise(dur, vol = 0.3, cutoff = 1200) {
      if (settings.muted || settings.sfxOff || !ensure()) return;
      const t = ac.currentTime;
      const len = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const f = ac.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      const g = ac.createGain();
      g.gain.value = vol;
      src.connect(f).connect(g).connect(master);
      src.start(t);
    }
    return {
      context: ensure,
      unlock() {
        if (ensure() && ac.state === "suspended") ac.resume();
      },
      kill(big) {
        noise(big ? 0.45 : 0.16, big ? 0.5 : 0.18, big ? 700 : 1800);
      },
      hit() {
        tone(140, 0.25, "sawtooth", 0.25, 0.4);
        noise(0.3, 0.4, 600);
      },
      pickup() {
        const now = performance.now();
        if (now - lastPickup < 45) return;
        lastPickup = now;
        tone(rand(880, 1320), 0.06, "sine", 0.08);
      },
      level() {
        [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.12, "triangle", 0.16), i * 70));
      },
      dash() {
        tone(320, 0.18, "sine", 0.14, 2.6);
      },
      boss() {
        tone(55, 1.2, "sawtooth", 0.25, 1.8);
      },
      wave() {
        tone(440, 0.1, "triangle", 0.12);
        setTimeout(() => tone(660, 0.16, "triangle", 0.12), 90);
      },
    };
  })();


  // ---------- music (original tracks, synthesized live; no audio files) ----------
  // A small step sequencer: every 25 ms it schedules the next ~0.15 s of notes
  // on the Web Audio clock, so timing stays tight even if a frame runs long.
  const music = (() => {
    const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    const VOLUME = 0.42;
    let ac = null;
    let out = null; // music master
    let echo = null; // delay send for the arps and leads
    let grit = null; // distortion for the boss bass
    let noise = null; // shared white-noise buffer for drums
    let timer = 0;
    let current = "off";
    let duck = 1;
    let notes = 0;
    let intensity = 0; // 0..1: the Hive enrages
    const tracks = {};

    // ----- track data (all original) -----
    // Normal waves: A minor synthwave, Am - F - C - G, 112 BPM.
    const PLAY = {
      bpm: 112,
      chords: [
        [57, 60, 64],
        [57, 60, 65],
        [55, 60, 64],
        [55, 59, 62],
      ],
      bass: [45, 41, 48, 43],
      lead: [
        [76, null, 81, null, 79, 76, null, 74],
        [72, null, 74, 76, null, 72, 69, null],
        [72, null, 79, null, 76, 72, null, 67],
        [71, null, 74, null, 79, null, 74, 71],
      ],
    };
    // Hive fights: E Phrygian, Em - F - Em - D, 140 BPM, gritty galloping bass.
    const BOSS = {
      bpm: 140,
      chords: [
        [64, 67, 71],
        [65, 69, 72],
        [64, 67, 71],
        [62, 66, 69],
      ],
      bass: [40, 41, 40, 38],
      lead: [
        [76, 77, 76, 71, 76, 77, 79, 77],
        [77, 79, 77, 72, 77, 79, 81, 79],
        [76, 77, 76, 71, 76, 79, 83, 79],
        [74, 76, 74, 69, 74, 76, 78, 74],
      ],
    };

    function init() {
      if (ac) return true;
      ac = sfx.context();
      if (!ac) return false;
      out = ac.createGain();
      out.gain.value = 0;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      const makeup = ac.createGain();
      makeup.gain.value = 2.2;
      out.connect(comp).connect(makeup).connect(ac.destination);

      echo = ac.createDelay(1);
      const fb = ac.createGain();
      const wet = ac.createGain();
      fb.gain.value = 0.32;
      wet.gain.value = 0.35;
      echo.connect(fb).connect(echo);
      echo.connect(wet).connect(out);

      grit = ac.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 3.2);
      }
      grit.curve = curve;
      const gritOut = ac.createGain();
      gritOut.gain.value = 1;
      grit.connect(gritOut).connect(out);

      noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      for (const name of ["calm", "play", "boss"]) {
        const g = ac.createGain();
        g.gain.value = 0;
        g.connect(out);
        tracks[name] = { name, gain: g, step: 0, next: 0, level: 0 };
      }
      timer = setInterval(schedule, 25);
      applyVolume(0.6);
      return true;
    }

    // ----- instruments -----
    function voice(dest, freq, t, dur, { type = "sawtooth", vol = 0.1, cutoff = 2000, attack = 0.005, release = 0.08, detune = 0, sendEcho = 0 } = {}) {
      const o = ac.createOscillator();
      const f = ac.createBiquadFilter();
      const g = ac.createGain();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      f.type = "lowpass";
      f.frequency.value = cutoff;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + attack);
      g.gain.setValueAtTime(vol, t + Math.max(attack, dur - release));
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(f).connect(g).connect(dest);
      if (sendEcho) {
        const s = ac.createGain();
        s.gain.value = sendEcho;
        g.connect(s).connect(echo);
      }
      o.start(t);
      o.stop(t + dur + 0.02);
      notes++;
    }

    function kick(dest, t, vol = 0.9) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.3);
      notes++;
    }

    function hiss(dest, t, dur, vol, freq, type = "highpass") {
      const src = ac.createBufferSource();
      src.buffer = noise;
      const f = ac.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(dest);
      src.start(t, Math.random() * 0.5, dur + 0.02);
      notes++;
    }

    function snare(dest, t, vol = 0.35) {
      hiss(dest, t, 0.16, vol, 1400);
      voice(dest, 190, t, 0.08, { type: "triangle", vol: vol * 0.6, cutoff: 1200 });
    }

    // ----- what each track plays on one 16th-note step -----
    function playStep(tr, step, t) {
      const d = tr.gain;
      const s16 = 60 / PLAY.bpm / 4;
      const bar = Math.floor(step / 16);
      const i = step % 16;
      const chordIx = bar % 4;
      const chord = PLAY.chords[chordIx];
      const calm = tr.name === "calm";
      // The 16-bar song: 4 intro bars, then drums, then the lead melody on bars 8-15.
      const section = bar < 4 ? 0 : bar % 16 < 8 ? 1 : 2;
      if (i === 0) {
        for (const n of chord) {
          voice(d, midi(n), t, s16 * 16, { vol: calm ? 0.05 : 0.04, cutoff: calm ? 900 : 1400, attack: 0.4, release: 0.6, detune: -7 });
          voice(d, midi(n), t, s16 * 16, { vol: calm ? 0.05 : 0.04, cutoff: calm ? 900 : 1400, attack: 0.4, release: 0.6, detune: 7 });
        }
      }
      // arpeggio
      const order = bar % 8 < 4 ? [0, 1, 2, 3, 2, 1, 0, 1] : [0, 2, 1, 3, 0, 2, 1, 3];
      const tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24];
      if (!calm || i % 2 === 0) {
        voice(d, midi(tones[order[i % 8]]), t, s16 * 0.9, { type: "square", vol: calm ? 0.035 : 0.04, cutoff: calm ? 1500 : 2600, sendEcho: 0.5 });
      }
      if (calm) return;
      // bass: pulsing 8ths with an octave pop on the offbeat
      if (i % 2 === 0) {
        const root = PLAY.bass[chordIx];
        voice(d, midi(i % 4 === 2 ? root + 12 : root), t, s16 * 1.8, { vol: 0.13, cutoff: 700 });
      }
      // drums
      if (i % 4 === 2) hiss(d, t, 0.04, 0.07, 8000);
      if (section >= 1) {
        if (i === 0 || i === 8 || (i === 10 && bar % 2)) kick(d, t, 0.8);
        if (i === 4 || i === 12) snare(d, t, 0.28);
        if (i % 2 === 1) hiss(d, t, 0.03, 0.035, 9000);
      }
      // lead melody (8th notes)
      if (section === 2 && i % 2 === 0) {
        const n = PLAY.lead[chordIx][i / 2];
        if (n) voice(d, midi(n), t, s16 * 1.9, { type: "sawtooth", vol: 0.06, cutoff: 3200, sendEcho: 0.45, detune: 5 });
      }
    }

    function bossStep(tr, step, t) {
      const d = tr.gain;
      const s16 = 60 / BOSS.bpm / 4;
      const bar = Math.floor(step / 16);
      const i = step % 16;
      const chordIx = bar % 4;
      const chord = BOSS.chords[chordIx];
      const root = BOSS.bass[chordIx];
      const hot = intensity > 0.5;
      // galloping distorted bass: da-da-DUM
      if ([0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15].includes(i)) {
        voice(grit, midi(i % 4 === 0 ? root : root + (i === 15 ? 12 : 0)), t, s16 * 0.85, { vol: 0.2, cutoff: hot ? 1800 : 1100 });
      }
      // four-on-the-floor + snare, with a roll at the end of every 4th bar
      if (i % 4 === 0) kick(d, t, 0.95);
      if (i === 4 || i === 12) snare(d, t, 0.34);
      if (bar % 4 === 3 && i >= 12) snare(d, t, 0.16 + (i - 12) * 0.05);
      hiss(d, t, i % 4 === 2 ? 0.12 : 0.03, i % 2 ? 0.03 : 0.05, 7500);
      // offbeat chord stabs
      if (i % 4 === 2) {
        for (const n of chord) voice(d, midi(n), t, s16 * 0.7, { type: "square", vol: 0.04, cutoff: hot ? 3500 : 2200 });
      }
      // siren lead on bars 4-7 of each 8 (always once the Hive is enraged)
      if ((bar % 8 >= 4 || hot) && i % 2 === 0) {
        const n = BOSS.lead[chordIx][i / 2];
        voice(d, midi(n), t, s16 * 1.8, { type: "sawtooth", vol: 0.07, cutoff: hot ? 4500 : 3000, sendEcho: 0.3, detune: 8 });
      }
      // low drone so the arena feels huge
      if (i === 0) voice(d, midi(root - 12), t, s16 * 16, { type: "triangle", vol: 0.08, cutoff: 300, attack: 0.2, release: 0.3 });
    }

    function schedule() {
      if (!ac || ac.state !== "running") return;
      const ahead = ac.currentTime + 0.15;
      for (const name in tracks) {
        const tr = tracks[name];
        if (tr.level <= 0.001 && tr.name !== current) continue;
        const bpm = name === "boss" ? BOSS.bpm : PLAY.bpm;
        const s16 = 60 / bpm / 4;
        if (tr.next < ac.currentTime) tr.next = ac.currentTime + 0.05;
        while (tr.next < ahead) {
          if (name === "boss") bossStep(tr, tr.step, tr.next);
          else playStep(tr, tr.step, tr.next);
          tr.step++;
          // after the first 16 bars, loop bars 4-15 (skip the intro)
          if (name !== "boss" && tr.step >= 256) tr.step = 64;
          tr.next += s16;
        }
      }
    }

    function applyVolume(fade = 0.4) {
      if (!ac) return;
      const on = settings.music && !settings.muted;
      const t = ac.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(on ? VOLUME * duck : 0, t, fade / 3);
    }

    return {
      // "calm" | "play" | "boss" | "off"
      play(name) {
        if (name === current || !init()) return;
        const t = ac.currentTime;
        for (const key in tracks) {
          const tr = tracks[key];
          const target = key === name ? (key === "boss" ? 1.3 : 1) : 0;
          if (target && tr.level <= 0.001) {
            tr.step = 0; // start the song from the top
            tr.next = t + 0.08;
          }
          tr.level = target;
          tr.gain.gain.cancelScheduledValues(t);
          tr.gain.gain.setTargetAtTime(target, t, name === "boss" || current === "boss" ? 0.25 : 0.6);
        }
        current = name;
      },
      duck(amount) {
        if (amount === duck) return;
        duck = amount;
        applyVolume(0.3);
      },
      intensity(x) {
        intensity = x;
      },
      refresh: () => applyVolume(0.2),
      suspend(hidden) {
        if (!ac) return;
        if (hidden) ac.suspend();
        else if (ac.state === "suspended") ac.resume();
      },
      state: () => ({ track: current, notes, running: !!ac && ac.state === "running" }),
    };
  })();

  // ---------- particles (struct of arrays) ----------
  const PMAX = 2400;
  const P = {
    x: new Float32Array(PMAX),
    y: new Float32Array(PMAX),
    vx: new Float32Array(PMAX),
    vy: new Float32Array(PMAX),
    life: new Float32Array(PMAX),
    max: new Float32Array(PMAX),
    size: new Float32Array(PMAX),
    drag: new Float32Array(PMAX),
    col: new Uint8Array(PMAX),
    bucket: new Uint8Array(PMAX),
    n: 0,
  };

  function particle(x, y, vx, vy, life, size, col, drag = 2.2) {
    if (P.n >= PMAX) return;
    const i = P.n++;
    P.x[i] = x;
    P.y[i] = y;
    P.vx[i] = vx;
    P.vy[i] = vy;
    P.life[i] = life;
    P.max[i] = life;
    P.size[i] = size;
    P.drag[i] = drag;
    P.col[i] = col;
  }

  function burst(x, y, col, count, speed, life = 0.6, size = 2) {
    const n = Math.round(count * q.particles);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * TAU;
      const s = speed * (0.25 + Math.random() * 0.9);
      particle(x, y, Math.cos(a) * s, Math.sin(a) * s, life * rand(0.5, 1.1), size * rand(0.7, 1.4), col);
    }
  }

  function updateParticles(dt) {
    for (let i = 0; i < P.n; i++) {
      P.life[i] -= dt;
      if (P.life[i] <= 0) {
        const last = --P.n;
        P.x[i] = P.x[last];
        P.y[i] = P.y[last];
        P.vx[i] = P.vx[last];
        P.vy[i] = P.vy[last];
        P.life[i] = P.life[last];
        P.max[i] = P.max[last];
        P.size[i] = P.size[last];
        P.drag[i] = P.drag[last];
        P.col[i] = P.col[last];
        i--;
        continue;
      }
      const k = Math.max(0, 1 - P.drag[i] * dt);
      P.vx[i] *= k;
      P.vy[i] *= k;
      P.x[i] += P.vx[i] * dt;
      P.y[i] += P.vy[i] * dt;
    }
  }

  // Draw every particle as a motion streak, batched by color and fade level.
  const bucketCount = new Uint16Array(COLORS.length * 3);
  function drawParticles() {
    bucketCount.fill(0);
    for (let i = 0; i < P.n; i++) {
      const f = P.life[i] / P.max[i];
      const b = P.col[i] * 3 + (f > 0.6 ? 2 : f > 0.3 ? 1 : 0);
      P.bucket[i] = b;
      bucketCount[b]++;
    }
    ctx.lineCap = "round";
    for (let b = 0; b < bucketCount.length; b++) {
      if (!bucketCount[b]) continue;
      const fade = b % 3;
      ctx.globalAlpha = fade === 2 ? 1 : fade === 1 ? 0.6 : 0.28;
      ctx.strokeStyle = COLORS[(b / 3) | 0];
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i < P.n; i++) {
        if (P.bucket[i] !== b) continue;
        const s = P.size[i] * 0.012;
        ctx.moveTo(P.x[i], P.y[i]);
        ctx.lineTo(P.x[i] - P.vx[i] * s - 0.5, P.y[i] - P.vy[i] * s);
      }
      ctx.stroke();
    }
  }

  // ---------- bullets ----------
  function pool(max, fields) {
    const o = { n: 0, max };
    for (const f of fields) o[f] = new Float32Array(max);
    return o;
  }
  const B = pool(900, ["x", "y", "vx", "vy", "life", "dmg", "pierce", "last", "kind"]); // kind 0 = ship, 1 = blade
  const EB = pool(500, ["x", "y", "vx", "vy", "life", "r"]);
  const G = pool(700, ["x", "y", "vx", "vy", "val", "age", "lock"]);

  function poolRemove(o, i) {
    const last = --o.n;
    for (const key in o) {
      const arr = o[key];
      if (arr instanceof Float32Array) arr[i] = arr[last];
    }
  }

  // ---------- warping background grid (spring mesh) ----------
  const GRID_STEP = 64;
  const GN = ARENA / GRID_STEP + 1;
  const grid = {
    x: new Float32Array(GN * GN),
    y: new Float32Array(GN * GN),
    vx: new Float32Array(GN * GN),
    vy: new Float32Array(GN * GN),
  };
  function resetGrid() {
    for (let j = 0; j < GN; j++) {
      for (let i = 0; i < GN; i++) {
        const k = j * GN + i;
        grid.x[k] = i * GRID_STEP;
        grid.y[k] = j * GRID_STEP;
        grid.vx[k] = 0;
        grid.vy[k] = 0;
      }
    }
  }

  function gridImpulse(x, y, radius, strength) {
    if (!q.grid) return;
    const i0 = Math.max(1, Math.floor((x - radius) / GRID_STEP));
    const i1 = Math.min(GN - 2, Math.ceil((x + radius) / GRID_STEP));
    const j0 = Math.max(1, Math.floor((y - radius) / GRID_STEP));
    const j1 = Math.min(GN - 2, Math.ceil((y + radius) / GRID_STEP));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * GN + i;
        const dx = grid.x[k] - x;
        const dy = grid.y[k] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius || d2 < 1) continue;
        const d = Math.sqrt(d2);
        const f = (strength * (1 - d / radius)) / d;
        grid.vx[k] += dx * f;
        grid.vy[k] += dy * f;
      }
    }
  }

  function updateGrid(dt) {
    if (!q.grid) return;
    const k1 = 26; // pull back to rest
    const k2 = 70; // pull toward neighbors (spreads the ripple)
    const damp = Math.max(0, 1 - 4.5 * dt);
    for (let j = 1; j < GN - 1; j++) {
      for (let i = 1; i < GN - 1; i++) {
        const k = j * GN + i;
        const rx = i * GRID_STEP;
        const ry = j * GRID_STEP;
        const nx = (grid.x[k - 1] + grid.x[k + 1] + grid.x[k - GN] + grid.x[k + GN]) * 0.25;
        const ny = (grid.y[k - 1] + grid.y[k + 1] + grid.y[k - GN] + grid.y[k + GN]) * 0.25;
        grid.vx[k] = (grid.vx[k] + ((rx - grid.x[k]) * k1 + (nx - grid.x[k]) * k2) * dt) * damp;
        grid.vy[k] = (grid.vy[k] + ((ry - grid.y[k]) * k1 + (ny - grid.y[k]) * k2) * dt) * damp;
      }
    }
    for (let k = 0; k < grid.x.length; k++) {
      grid.x[k] += grid.vx[k] * dt;
      grid.y[k] += grid.vy[k] * dt;
    }
  }

  function drawGrid(x0, y0, x1, y1) {
    const i0 = clamp(Math.floor(x0 / GRID_STEP) - 1, 0, GN - 1);
    const i1 = clamp(Math.ceil(x1 / GRID_STEP) + 1, 0, GN - 1);
    const j0 = clamp(Math.floor(y0 / GRID_STEP) - 1, 0, GN - 1);
    const j1 = clamp(Math.ceil(y1 / GRID_STEP) + 1, 0, GN - 1);
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = "#5b3cff";
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      let k = j * GN + i0;
      ctx.moveTo(grid.x[k], grid.y[k]);
      for (let i = i0 + 1; i <= i1; i++) {
        k = j * GN + i;
        ctx.lineTo(grid.x[k], grid.y[k]);
      }
    }
    for (let i = i0; i <= i1; i++) {
      let k = j0 * GN + i;
      ctx.moveTo(grid.x[k], grid.y[k]);
      for (let j = j0 + 1; j <= j1; j++) {
        k = j * GN + i;
        ctx.lineTo(grid.x[k], grid.y[k]);
      }
    }
    ctx.stroke();
    // brighter major lines every 4 cells
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "#8a5cff";
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      if (j % 4) continue;
      let k = j * GN + i0;
      ctx.moveTo(grid.x[k], grid.y[k]);
      for (let i = i0 + 1; i <= i1; i++) {
        k = j * GN + i;
        ctx.lineTo(grid.x[k], grid.y[k]);
      }
    }
    for (let i = i0; i <= i1; i++) {
      if (i % 4) continue;
      let k = j0 * GN + i;
      ctx.moveTo(grid.x[k], grid.y[k]);
      for (let j = j0 + 1; j <= j1; j++) {
        k = j * GN + i;
        ctx.lineTo(grid.x[k], grid.y[k]);
      }
    }
    ctx.stroke();
  }

  // ---------- enemies + spatial grid ----------
  const enemies = [];
  const enemyPool = [];
  let nextId = 1;
  const CELL = 80;
  const CN = Math.ceil(ARENA / CELL);
  const cellStart = new Int32Array(CN * CN + 1);
  const cellFill = new Int32Array(CN * CN);
  let cellItems = new Int32Array(512);

  function cellOf(x, y) {
    const cx = clamp((x / CELL) | 0, 0, CN - 1);
    const cy = clamp((y / CELL) | 0, 0, CN - 1);
    return cy * CN + cx;
  }

  function buildCells() {
    if (cellItems.length < enemies.length) cellItems = new Int32Array(enemies.length * 2);
    cellStart.fill(0);
    for (const e of enemies) {
      e.cell = cellOf(e.x, e.y);
      cellStart[e.cell + 1]++;
    }
    for (let c = 0; c < CN * CN; c++) cellStart[c + 1] += cellStart[c];
    cellFill.set(cellStart.subarray(0, CN * CN));
    for (let i = 0; i < enemies.length; i++) cellItems[cellFill[enemies[i].cell]++] = i;
  }

  // Calls fn(enemy) for enemies whose cells touch the circle (x, y, r).
  function nearby(x, y, r, fn) {
    const cx0 = clamp(((x - r - 60) / CELL) | 0, 0, CN - 1);
    const cx1 = clamp(((x + r + 60) / CELL) | 0, 0, CN - 1);
    const cy0 = clamp(((y - r - 60) / CELL) | 0, 0, CN - 1);
    const cy1 = clamp(((y + r + 60) / CELL) | 0, 0, CN - 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * CN + cx;
        for (let s = cellStart[c]; s < cellStart[c + 1]; s++) {
          const e = enemies[cellItems[s]];
          if (e && !e.dead && fn(e) === false) return;
        }
      }
    }
  }

  function spawnEnemy(kind, x, y) {
    const info = ENEMY[kind];
    const e = enemyPool.pop() || {};
    const hpScale = game.plan ? game.plan.hp_scale : 1;
    const speedScale = game.plan ? game.plan.speed_scale : 1;
    e.id = nextId++;
    e.kind = kind;
    e.col = KIND_COLOR[kind];
    e.x = clamp(x, info.radius, ARENA - info.radius);
    e.y = clamp(y, info.radius, ARENA - info.radius);
    e.vx = 0;
    e.vy = 0;
    e.r = info.radius;
    e.maxHp = Math.max(1, Math.round(info.hp * hpScale));
    e.hp = e.maxHp;
    e.speed = info.speed * speedScale;
    e.ang = Math.random() * TAU;
    e.spin = rand(-2, 2);
    e.t = rand(0, 2);
    e.state = 0;
    e.timer = rand(0.4, 1.2);
    e.flash = 0;
    e.blade = 0;
    e.dirx = 0;
    e.diry = 0;
    e.dead = false;
    e.born = 0.35;
    e.cell = 0;
    enemies.push(e);
    burst(e.x, e.y, e.col, 10, 220, 0.4, 2);
    return e;
  }

  // ---------- game state ----------
  const game = {
    mode: "menu", // menu | play | levelup | pause | over
    seed: null,
    daily: false,
    wave: 0,
    plan: null,
    nextPlan: null,
    groups: [],
    waveTime: 0,
    between: 0,
    telegraphs: [],
    rings: [],
    texts: [],
    score: 0,
    kills: 0,
    combo: 0,
    comboT: 0,
    time: 0,
    slow: 0,
    slowScale: 1,
    shake: 0,
    flash: 0,
    pendingLevels: 0,
    overT: 0,
    bosses: [],
  };

  const player = {
    x: ARENA / 2,
    y: ARENA / 2,
    vx: 0,
    vy: 0,
    r: 14,
    ang: -Math.PI / 2,
    shields: 3,
    maxShields: 3,
    inv: 0,
    dashT: 0,
    dashCd: 0,
    dashX: 0,
    dashY: -1,
    fireT: 0,
    level: 1,
    xp: 0,
    up: {},
    bladeAng: 0,
    blades: [], // { hp, x, y, hitT } — each blade breaks after CONFIG.blade_hp enemy-bullet hits
    bladeFireT: 0,
    bladeNext: 0,
    alive: true,
    trail: 0,
  };

  const cam = { x: ARENA / 2, y: ARENA / 2 };

  function stat(key) {
    return player.up[key] || 0;
  }
  const S = {
    // Endless upgrades grow fast at first, then slower, so late runs stay playable.
    fireRate: () => 6 * Math.pow(1.18, Math.min(6, stat("rapid"))) * (1 + 0.06 * Math.max(0, stat("rapid") - 6)),
    shots: () => 1 + stat("spread"),
    pierce: () => stat("pierce"),
    dmg: () => 1 + stat("power"),
    speed: () => 290 * Math.pow(1.12, stat("speed")),
    magnet: () => Math.min(1100, 95 * (1 + 0.6 * Math.min(3, stat("magnet")) + 0.25 * Math.max(0, stat("magnet") - 3))),
    dashCd: () => 1.5 * Math.pow(0.75, stat("dash")),
    blades: () => player.blades.length,
    nova: () => stat("nova"),
  };

  // ---------- input ----------
  const keys = new Set();
  const input = {
    mouseX: 0,
    mouseY: 0,
    mouseT: -99, // time of last mouse move: recent movement means "aim with mouse"
    stick: null,
    autoAim: true,
  };

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    keys.add(k);
    if (game.mode === "play") {
      if (k === " " || k === "shift") {
        e.preventDefault();
        dash();
      }
      if (k === "p" || k === "escape") pause(true);
    } else if (game.mode === "pause" && (k === "p" || k === "escape")) {
      pause(false);
    } else if (game.mode === "levelup" && ["1", "2", "3"].includes(k)) {
      const card = $(`#cards .card:nth-child(${k})`);
      if (card) card.click();
    }
    if (k === "m") {
      settings.muted = !settings.muted;
      store.set("neon-swarm:muted", settings.muted);
      music.refresh();
      showBanner(settings.muted ? "MUTED" : "SOUND ON", "", false, 0.8);
    }
    if (k === "n") setMusic(!settings.music);
    if (k === "f") {
      settings.fps = !settings.fps;
      $("#fps").hidden = !settings.fps;
    }
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => {
    keys.clear();
    input.stick = null;
  });

  canvas.addEventListener("pointerdown", (e) => {
    sfx.unlock();
    if (e.pointerType === "mouse") {
      input.mouseX = e.clientX;
      input.mouseY = e.clientY;
      input.mouseT = game.time;
      if (e.button === 2 && game.mode === "play") dash();
      return;
    }
    if (!input.stick) {
      input.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") {
      input.mouseX = e.clientX;
      input.mouseY = e.clientY;
      input.mouseT = game.time;
      return;
    }
    const st = input.stick;
    if (st && st.id === e.pointerId) {
      st.x = e.clientX;
      st.y = e.clientY;
      // let the stick's base follow the thumb so it never "runs out"
      const max = 60;
      const dx = st.x - st.ox;
      const dy = st.y - st.oy;
      const d = Math.hypot(dx, dy);
      if (d > max) {
        st.ox = st.x - (dx / d) * max;
        st.oy = st.y - (dy / d) * max;
      }
    }
  });
  const endStick = (e) => {
    if (input.stick && input.stick.id === e.pointerId) input.stick = null;
  };
  canvas.addEventListener("pointerup", endStick);
  canvas.addEventListener("pointercancel", endStick);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  $("#dash-btn").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sfx.unlock();
    dash();
  });

  function moveInput() {
    let x = 0;
    let y = 0;
    if (keys.has("a") || keys.has("arrowleft")) x -= 1;
    if (keys.has("d") || keys.has("arrowright")) x += 1;
    if (keys.has("w") || keys.has("arrowup")) y -= 1;
    if (keys.has("s") || keys.has("arrowdown")) y += 1;
    const st = input.stick;
    if (st) {
      const dx = st.x - st.ox;
      const dy = st.y - st.oy;
      const d = Math.hypot(dx, dy);
      if (d > 6) {
        const m = Math.min(1, d / 50);
        x += (dx / d) * m;
        y += (dy / d) * m;
      }
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return [x, y];
  }

  // ---------- core actions ----------
  function dash() {
    if (game.mode !== "play" || !player.alive || player.dashCd > 0) return;
    let [mx, my] = moveInput();
    if (!mx && !my) {
      mx = Math.cos(player.ang);
      my = Math.sin(player.ang);
    }
    const len = Math.hypot(mx, my) || 1;
    player.dashX = mx / len;
    player.dashY = my / len;
    player.dashT = 0.17;
    player.dashCd = S.dashCd();
    sfx.dash();
    burst(player.x, player.y, C.cyan, 16, 260, 0.35, 2);
    const nova = S.nova();
    if (nova) {
      const radius = 110 + 50 * nova;
      ring(player.x, player.y, radius, C.pink, 0.4, 6);
      gridImpulse(player.x, player.y, radius * 1.3, 900);
      nearby(player.x, player.y, radius, (e) => {
        const d = Math.hypot(e.x - player.x, e.y - player.y);
        if (d < radius + e.r) damageEnemy(e, 2 + nova * 2, (e.x - player.x) / (d || 1), (e.y - player.y) / (d || 1), 260);
      });
    }
  }

  function ring(x, y, maxR, col, life, width) {
    if (game.rings.length > 40) game.rings.shift();
    game.rings.push({ x, y, r: 0, maxR, col, life, max: life, width });
  }

  function floatText(x, y, text, col) {
    if (game.texts.length > 30) game.texts.shift();
    game.texts.push({ x, y, text, col, life: 0.9 });
  }

  function addShake(amount) {
    if (settings.shake) game.shake = Math.min(1, game.shake + amount);
  }

  function slowmo(seconds, timeScale) {
    game.slow = Math.max(game.slow, seconds);
    game.slowScale = Math.min(game.slowScale, timeScale);
  }

  const shotCount = [0, 0]; // [ship, blade] bullets fired this run

  function spawnBullet(x, y, a, speed, kind) {
    if (B.n >= B.max) return;
    const i = B.n++;
    B.x[i] = x;
    B.y[i] = y;
    B.vx[i] = Math.cos(a) * speed;
    B.vy[i] = Math.sin(a) * speed;
    B.life[i] = 0.8;
    B.dmg[i] = S.dmg();
    B.pierce[i] = S.pierce();
    B.last[i] = -1;
    B.kind[i] = kind;
    shotCount[kind]++;
  }

  function fire() {
    const shots = S.shots();
    const spread = 0.13;
    const base = player.ang - ((shots - 1) * spread) / 2;
    for (let s = 0; s < shots; s++) {
      const a = base + s * spread + rand(-0.02, 0.02);
      spawnBullet(player.x + Math.cos(a) * 18, player.y + Math.sin(a) * 18, a, 980, 0);
    }
    const mx = player.x + Math.cos(player.ang) * 20;
    const my = player.y + Math.sin(player.ang) * 20;
    for (let k = 0; k < 2; k++) {
      const a = player.ang + rand(-0.5, 0.5);
      particle(mx, my, Math.cos(a) * rand(120, 260), Math.sin(a) * rand(120, 260), 0.12, 2, C.yellow, 6);
    }
  }

  function damageEnemy(e, dmg, dx, dy, push) {
    if (e.dead) return;
    e.hp -= dmg;
    e.flash = 0.07;
    const k = e.kind === "tank" || e.kind === "hive" ? 0.15 : 1;
    e.vx += dx * push * k;
    e.vy += dy * push * k;
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    const info = ENEMY[e.kind];
    game.kills++;
    game.combo++;
    game.comboT = 1.8;
    const mult = comboMult();
    const pts = Math.round(info.score * mult);
    game.score += pts;
    const big = e.kind === "tank" || e.kind === "hive";
    const size = e.kind === "hive" ? 3 : big ? 1.8 : 1;
    burst(e.x, e.y, e.col, 26 * size, 420 * size, 0.8, 2.5);
    burst(e.x, e.y, C.white, 10 * size, 300 * size, 0.4, 2);
    ring(e.x, e.y, e.r * 3.2 * (e.kind === "hive" ? 2.5 : 1), e.col, 0.45, 4);
    gridImpulse(e.x, e.y, 120 + e.r * 4, 520 * size);
    addShake(e.kind === "hive" ? 1 : big ? 0.35 : 0.06);
    if (pts >= 50 || mult > 1.5) floatText(e.x, e.y - e.r, `+${pts}`, mult > 1.5 ? C.yellow : C.white);
    sfx.kill(big);
    dropXp(e.x, e.y, info.xp);
    if (e.kind === "splitter") {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + e.ang;
        const s = spawnEnemy("shard", e.x + Math.cos(a) * 14, e.y + Math.sin(a) * 14);
        s.vx = Math.cos(a) * 320;
        s.vy = Math.sin(a) * 320;
        s.born = 0;
      }
    }
    if (e.kind === "hive") {
      slowmo(0.9, 0.2);
      game.flash = 0.6;
      for (let k = 0; k < 4; k++) {
        setTimeout(() => {
          burst(e.x + rand(-60, 60), e.y + rand(-60, 60), [C.green, C.white, C.yellow][k % 3], 40, 600, 1, 3);
          gridImpulse(e.x, e.y, 400, 1200);
        }, k * 120);
      }
      // the hive's leftover drones die with it
      for (const other of enemies) if (!other.dead && other.kind === "drifter" && Math.hypot(other.x - e.x, other.y - e.y) < 500) killEnemy(other);
    } else if (big) {
      slowmo(0.06, 0.05); // tiny hit-stop sells the impact
    }
  }

  function comboMult() {
    return Math.min(5, 1 + Math.floor(game.combo / 6) * 0.5);
  }

  function dropXp(x, y, total) {
    while (total > 0 && G.n < G.max) {
      const val = total >= 5 ? 5 : 1;
      total -= val;
      const i = G.n++;
      const a = Math.random() * TAU;
      const s = rand(40, 180);
      G.x[i] = x;
      G.y[i] = y;
      G.vx[i] = Math.cos(a) * s;
      G.vy[i] = Math.sin(a) * s;
      G.val[i] = val;
      G.age[i] = 0;
      G.lock[i] = 0;
    }
  }

  function hurtPlayer(fromX, fromY) {
    if (game.mode !== "play" || player.inv > 0 || player.dashT > 0 || !player.alive) return;
    const d = Math.hypot(player.x - fromX, player.y - fromY) || 1;
    player.vx += ((player.x - fromX) / d) * 600;
    player.vy += ((player.y - fromY) / d) * 600;
    sfx.hit();
    addShake(0.8);
    game.flash = 0.35;
    burst(player.x, player.y, C.red, 30, 420, 0.7, 2.5);
    gridImpulse(player.x, player.y, 260, 1100);
    if (player.shields <= 0) {
      die();
      return;
    }
    player.shields--;
    player.inv = 1.5;
    slowmo(0.35, 0.25);
    // mercy: clear enemy bullets near you
    for (let i = 0; i < EB.n; i++) {
      if (Math.hypot(EB.x[i] - player.x, EB.y[i] - player.y) < 200) {
        burst(EB.x[i], EB.y[i], C.purple, 3, 100, 0.3, 1.5);
        poolRemove(EB, i--);
      }
    }
    updateHud(true);
  }

  function die() {
    player.alive = false;
    slowmo(1.4, 0.2);
    game.overT = 1.6;
    burst(player.x, player.y, C.cyan, 80, 700, 1.4, 3);
    burst(player.x, player.y, C.white, 40, 500, 1, 2);
    ring(player.x, player.y, 400, C.cyan, 0.9, 8);
    gridImpulse(player.x, player.y, 600, 2400);
    sfx.kill(true);
  }

  // ---------- waves ----------
  function spawnPoints(pattern, count) {
    const pts = [];
    const px = player.x;
    const py = player.y;
    const m = 40;
    if (pattern === "ring") {
      const R = 430;
      const off = Math.random() * TAU;
      for (let k = 0; k < count; k++) {
        const a = off + (k / count) * TAU;
        pts.push([px + Math.cos(a) * R, py + Math.sin(a) * R]);
      }
    } else if (pattern === "corner") {
      const corners = [[m, m], [ARENA - m, m], [m, ARENA - m], [ARENA - m, ARENA - m]];
      corners.sort((a, b) => Math.hypot(b[0] - px, b[1] - py) - Math.hypot(a[0] - px, a[1] - py));
      const [cx, cy] = corners[Math.random() < 0.5 ? 0 : 1];
      for (let k = 0; k < count; k++) pts.push([cx + rand(-120, 120), cy + rand(-120, 120)]);
    } else if (pattern === "line") {
      const vertical = Math.random() < 0.5;
      const far = vertical ? (px < ARENA / 2 ? ARENA - 220 : 220) : py < ARENA / 2 ? ARENA - 220 : 220;
      const center = vertical ? py : px;
      for (let k = 0; k < count; k++) {
        const along = center + (k - (count - 1) / 2) * 70;
        pts.push(vertical ? [far, along] : [along, far]);
      }
    } else {
      for (let k = 0; k < count; k++) {
        const side = (Math.random() * 4) | 0;
        const t = rand(m, ARENA - m);
        pts.push(side === 0 ? [t, m] : side === 1 ? [ARENA - m, t] : side === 2 ? [t, ARENA - m] : [m, t]);
      }
    }
    // never spawn on top of the player
    for (const p of pts) {
      p[0] = clamp(p[0], m, ARENA - m);
      p[1] = clamp(p[1], m, ARENA - m);
      const dx = p[0] - px;
      const dy = p[1] - py;
      const d = Math.hypot(dx, dy);
      if (d < 260) {
        const a = d > 1 ? Math.atan2(dy, dx) : Math.random() * TAU;
        p[0] = clamp(px + Math.cos(a) * 260, m, ARENA - m);
        p[1] = clamp(py + Math.sin(a) * 260, m, ARENA - m);
      }
    }
    return pts;
  }

  // Bosses drop in on screen, between you and the middle of the arena.
  function hivePoints(count) {
    const base = Math.atan2(ARENA / 2 - player.y, ARENA / 2 - player.x) || -Math.PI / 2;
    return Array.from({ length: count }, (_, k) => {
      const a = base + (k - (count - 1) / 2) * 1.1;
      return [clamp(player.x + Math.cos(a) * 380, 120, ARENA - 120), clamp(player.y + Math.sin(a) * 380, 120, ARENA - 120)];
    });
  }

  function startWave(plan) {
    game.plan = plan;
    game.wave = plan.wave;
    game.groups = plan.groups.map((g) => ({ ...g, done: false }));
    game.waveTime = 0;
    game.between = 0;
    if (plan.boss) {
      showBanner("THE HIVE", `WAVE ${plan.wave}`, true, 2.2);
      sfx.boss();
    } else {
      showBanner(`WAVE ${plan.wave}`, plan.wave === 1 ? (game.daily ? "DAILY RUN" : "GOOD LUCK") : "", false, 1.6);
      sfx.wave();
    }
    $("#wave-label").textContent = `WAVE ${plan.wave}`;
    game.nextPlan = fetchWave(plan.wave + 1);
  }

  async function fetchWave(n) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await api.wave(game.seed, n);
      } catch {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    return null;
  }

  function updateWave(dt) {
    if (!game.plan || !player.alive) return;
    if (game.between > 0) {
      game.between -= dt;
      if (game.between <= 0) {
        const pending = game.nextPlan;
        game.plan = null;
        pending.then((plan) => {
          if (game.mode === "menu") return;
          if (plan) startWave(plan);
          else showBanner("CONNECTION LOST", "reload to keep playing", false, 4);
        });
      }
      return;
    }
    game.waveTime += dt;
    for (const g of game.groups) {
      if (g.done || g.at > game.waveTime) continue;
      g.done = true;
      const pts = g.kind === "hive" ? hivePoints(g.count) : spawnPoints(g.pattern, g.count);
      pts.forEach(([x, y], k) => game.telegraphs.push({ kind: g.kind, x, y, t: g.kind === "hive" ? 1.4 : 0.75 + k * 0.05 }));
    }
    const allOut = game.groups.every((g) => g.done) && game.telegraphs.length === 0;
    if (allOut && enemies.length === 0) {
      game.between = 2.2;
      showBanner("CLEAR", `+${50 * game.wave} bonus`, false, 1.6);
      game.score += 50 * game.wave;
      ring(player.x, player.y, 900, C.cyan, 0.9, 3);
      gridImpulse(player.x, player.y, 700, 700);
    }
  }

  // ---------- simulation ----------
  function update(dt) {
    game.time += dt;
    updatePlayer(dt);
    buildCells();
    updateEnemies(dt);
    updateTelegraphs(dt);
    updateBullets(dt);
    updateEnemyBullets(dt);
    updateGems(dt);
    updateBlades(dt);
    updateParticles(dt);
    updateGrid(Math.min(dt, 1 / 45));
    updateWave(dt);

    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].dead) {
        enemyPool.push(enemies[i]);
        enemies[i] = enemies[enemies.length - 1];
        enemies.pop();
      }
    }
    for (let i = game.rings.length - 1; i >= 0; i--) {
      const r = game.rings[i];
      r.life -= dt;
      r.r = r.maxR * (1 - Math.pow(r.life / r.max, 2));
      if (r.life <= 0) game.rings.splice(i, 1);
    }
    for (let i = game.texts.length - 1; i >= 0; i--) {
      const t = game.texts[i];
      t.life -= dt;
      t.y -= 40 * dt;
      if (t.life <= 0) game.texts.splice(i, 1);
    }
    if (game.comboT > 0) {
      game.comboT -= dt;
      if (game.comboT <= 0) game.combo = 0;
    }
  }

  function updatePlayer(dt) {
    player.inv = Math.max(0, player.inv - dt);
    player.dashCd = Math.max(0, player.dashCd - dt);
    if (!player.alive || game.mode === "menu") return;
    const [mx, my] = moveInput();
    const sp = S.speed();
    if (player.dashT > 0) {
      player.dashT -= dt;
      player.vx = player.dashX * sp * 3.4;
      player.vy = player.dashY * sp * 3.4;
      particle(player.x, player.y, -player.vx * 0.1, -player.vy * 0.1, 0.3, 3, C.cyan, 4);
    } else {
      const a = Math.min(1, 14 * dt);
      player.vx += (mx * sp - player.vx) * a;
      player.vy += (my * sp - player.vy) * a;
    }
    player.x = clamp(player.x + player.vx * dt, player.r, ARENA - player.r);
    player.y = clamp(player.y + player.vy * dt, player.r, ARENA - player.r);

    // engine trail
    player.trail += dt;
    const moving = Math.hypot(player.vx, player.vy) > 40;
    if (moving && player.trail > 0.016) {
      player.trail = 0;
      const back = Math.atan2(player.vy, player.vx) + Math.PI;
      particle(
        player.x + Math.cos(back) * 12,
        player.y + Math.sin(back) * 12,
        Math.cos(back + rand(-0.3, 0.3)) * 160,
        Math.sin(back + rand(-0.3, 0.3)) * 160,
        0.35,
        2.2,
        Math.random() < 0.5 ? C.pink : C.orange,
        3,
      );
    }

    // aim: the mouse if it moved recently, otherwise the nearest enemy
    let target = null;
    const mouseAim = game.time - input.mouseT < 2.5;
    if (mouseAim) {
      target = [(input.mouseX - vw / 2) / scale + cam.x, (input.mouseY - vh / 2) / scale + cam.y];
    } else {
      let best = 720 * 720;
      for (const e of enemies) {
        if (e.dead || e.born > 0.2) continue;
        const d = (e.x - player.x) ** 2 + (e.y - player.y) ** 2;
        if (d < best) {
          best = d;
          target = [e.x, e.y];
        }
      }
    }
    if (target) {
      const want = Math.atan2(target[1] - player.y, target[0] - player.x);
      let diff = ((want - player.ang + Math.PI * 3) % TAU) - Math.PI;
      player.ang += diff * Math.min(1, (mouseAim ? 30 : 16) * dt);
    } else if (moving) {
      const want = Math.atan2(player.vy, player.vx);
      let diff = ((want - player.ang + Math.PI * 3) % TAU) - Math.PI;
      player.ang += diff * Math.min(1, 8 * dt);
    }
    // Catch up on missed shots after a long frame (up to 4), like the blade guns,
    // so a slow device doesn't quietly lower the ship's fire rate.
    player.fireT -= dt;
    for (let guard = 0; guard < 4 && player.fireT <= 0; guard++) {
      if (mouseAim ? enemies.length > 0 : target) {
        fire();
        player.fireT += 1 / S.fireRate();
      } else {
        player.fireT = 0;
        break;
      }
    }
  }

  let sepSelf = null;
  function separate(o) {
    const e = sepSelf;
    if (o === e) return true;
    const sx = e.x - o.x;
    const sy = e.y - o.y;
    const min = e.r + o.r;
    const d2 = sx * sx + sy * sy;
    if (d2 < min * min && d2 > 0.01) {
      const dd = Math.sqrt(d2);
      const push = ((min - dd) / dd) * 6;
      e.vx += sx * push;
      e.vy += sy * push;
    }
    return true;
  }

  function updateEnemies(dt) {
    const px = player.x;
    const py = player.y;
    for (const e of enemies) {
      if (e.dead) continue;
      e.t += dt;
      e.flash = Math.max(0, e.flash - dt);
      e.blade = Math.max(0, e.blade - dt);
      e.born = Math.max(0, e.born - dt);
      e.ang += e.spin * dt;
      const dx = px - e.x;
      const dy = py - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      let ax = 0;
      let ay = 0;
      switch (e.kind) {
        case "drifter": {
          const w = Math.sin(e.t * 3 + e.id) * 0.4;
          ax = (ux - uy * w) * e.speed;
          ay = (uy + ux * w) * e.speed;
          break;
        }
        case "shard":
        case "splitter":
        case "tank":
          ax = ux * e.speed;
          ay = uy * e.speed;
          break;
        case "dart": {
          e.timer -= dt;
          if (e.state === 0) {
            // aiming
            e.ang = Math.atan2(dy, dx);
            ax = -ux * 30;
            ay = -uy * 30;
            if (e.timer <= 0) {
              e.state = 1;
              e.timer = 1.1;
              e.dirx = ux;
              e.diry = uy;
              burst(e.x, e.y, e.col, 6, 160, 0.3, 2);
            }
          } else if (e.state === 1) {
            ax = e.dirx * e.speed;
            ay = e.diry * e.speed;
            if (Math.random() < 0.6) particle(e.x, e.y, -e.dirx * 80, -e.diry * 80, 0.25, 2, C.yellow, 4);
            if (e.timer <= 0) {
              e.state = 0;
              e.timer = rand(0.6, 1);
            }
          }
          break;
        }
        case "orbiter": {
          const want = 290;
          const radial = (d - want) / want;
          ax = (ux * radial * 2 - uy * 0.9) * e.speed;
          ay = (uy * radial * 2 + ux * 0.9) * e.speed;
          e.timer -= dt;
          if (e.timer <= 0 && d < 700) {
            e.timer = rand(1.8, 2.6);
            enemyShot(e.x, e.y, Math.atan2(dy, dx), 230);
          }
          break;
        }
        case "hive": {
          // each hive circles you at its own angle, so several never stack
          const ha = e.id * 2.4 + e.t * 0.25;
          const hx = clamp(px + Math.cos(ha) * 300, 120, ARENA - 120) - e.x;
          const hy = clamp(py + Math.sin(ha) * 300, 120, ARENA - 120) - e.y;
          const hd = Math.hypot(hx, hy) || 1;
          ax = (hx / hd) * e.speed;
          ay = (hy / hd) * e.speed;
          e.timer -= dt;
          const enraged = e.hp < e.maxHp / 2;
          if (e.timer <= 0) {
            e.state++;
            e.timer = enraged ? 1.5 : 2.3;
            const n = enraged ? 22 : 16;
            const off = e.state * 0.17;
            for (let k = 0; k < n; k++) enemyShot(e.x, e.y, off + (k / n) * TAU, enraged ? 210 : 170);
            ring(e.x, e.y, 140, C.green, 0.4, 4);
            gridImpulse(e.x, e.y, 300, 500);
            if (e.state % 3 === 0) {
              for (let k = 0; k < 5; k++) {
                const a = Math.random() * TAU;
                const s = spawnEnemy("drifter", e.x + Math.cos(a) * 70, e.y + Math.sin(a) * 70);
                s.born = 0.1;
              }
            }
          }
          if (enraged && Math.random() < dt * 4) {
            enemyShot(e.x, e.y, e.t * 2.3, 260);
          }
          break;
        }
        default:
          break;
      }
      // steer velocity toward the desired motion; knockback decays naturally
      const steer = Math.min(1, (e.kind === "dart" && e.state === 1 ? 10 : 3.2) * dt);
      e.vx += (ax - e.vx) * steer;
      e.vy += (ay - e.vy) * steer;

      // separation so the swarm doesn't collapse into one blob
      {
        sepSelf = e;
        nearby(e.x, e.y, e.r, separate);
      }

      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.x < e.r || e.x > ARENA - e.r) {
        e.x = clamp(e.x, e.r, ARENA - e.r);
        e.vx *= -0.6;
        if (e.kind === "dart") e.dirx *= -1;
      }
      if (e.y < e.r || e.y > ARENA - e.r) {
        e.y = clamp(e.y, e.r, ARENA - e.r);
        e.vy *= -0.6;
        if (e.kind === "dart") e.diry *= -1;
      }

      // touching the player
      if (player.alive && e.born <= 0 && game.mode === "play") {
        const hit = player.r + e.r * 0.85;
        if ((e.x - px) ** 2 + (e.y - py) ** 2 < hit * hit) {
          if (player.inv <= 0 && player.dashT <= 0) {
            hurtPlayer(e.x, e.y);
            if (e.kind !== "tank" && e.kind !== "hive") damageEnemy(e, 999, 0, 0, 0);
          } else if (e.kind === "tank" || e.kind === "hive") {
            player.vx -= ux * 300 * dt * 10;
            player.vy -= uy * 300 * dt * 10;
          }
        }
      }
    }
  }

  function enemyShot(x, y, angle, speed) {
    if (EB.n >= EB.max) return;
    const i = EB.n++;
    EB.x[i] = x;
    EB.y[i] = y;
    EB.vx[i] = Math.cos(angle) * speed;
    EB.vy[i] = Math.sin(angle) * speed;
    EB.life[i] = 6;
    EB.r[i] = 7;
  }

  function updateTelegraphs(dt) {
    for (let i = game.telegraphs.length - 1; i >= 0; i--) {
      const tg = game.telegraphs[i];
      tg.t -= dt;
      if (tg.t <= 0) {
        spawnEnemy(tg.kind, tg.x, tg.y);
        if (tg.kind === "hive") {
          gridImpulse(tg.x, tg.y, 500, 2000);
          addShake(0.6);
        }
        game.telegraphs.splice(i, 1);
      }
    }
  }

  // Hoisted so the per-bullet collision check allocates nothing.
  let hitIndex = 0;
  let hitGone = false;
  function bulletVisit(e) {
    const i = hitIndex;
    if (e.id === B.last[i] || e.born > 0.2) return true;
    const x = B.x[i];
    const y = B.y[i];
    const rr = e.r + 5;
    if ((e.x - x) ** 2 + (e.y - y) ** 2 > rr * rr) return true;
    const sp = Math.hypot(B.vx[i], B.vy[i]) || 1;
    for (let k = 0; k < 3; k++) {
      const a = Math.atan2(-B.vy[i], -B.vx[i]) + rand(-0.8, 0.8);
      particle(x, y, Math.cos(a) * rand(100, 300), Math.sin(a) * rand(100, 300), 0.2, 1.6, e.col, 5);
    }
    damageEnemy(e, B.dmg[i], B.vx[i] / sp, B.vy[i] / sp, 60);
    if (B.pierce[i] > 0) {
      B.pierce[i]--;
      B.last[i] = e.id;
      return true;
    }
    hitGone = true;
    return false;
  }

  function updateBullets(dt) {
    for (let i = 0; i < B.n; i++) {
      B.life[i] -= dt;
      B.x[i] += B.vx[i] * dt;
      B.y[i] += B.vy[i] * dt;
      const x = B.x[i];
      const y = B.y[i];
      if (B.life[i] <= 0 || x < 0 || y < 0 || x > ARENA || y > ARENA) {
        if (B.life[i] > 0) burst(clamp(x, 0, ARENA), clamp(y, 0, ARENA), C.pink, 3, 140, 0.25, 1.5);
        poolRemove(B, i--);
        continue;
      }
      hitIndex = i;
      hitGone = false;
      nearby(x, y, 6, bulletVisit);
      if (hitGone) poolRemove(B, i--);
    }
  }

  function updateEnemyBullets(dt) {
    for (let i = 0; i < EB.n; i++) {
      EB.life[i] -= dt;
      EB.x[i] += EB.vx[i] * dt;
      EB.y[i] += EB.vy[i] * dt;
      const x = EB.x[i];
      const y = EB.y[i];
      if (EB.life[i] <= 0 || x < -20 || y < -20 || x > ARENA + 20 || y > ARENA + 20) {
        poolRemove(EB, i--);
        continue;
      }
      // Blades block enemy bullets (and take a hit each time).
      let blocked = false;
      for (let k = 0; k < player.blades.length && player.alive; k++) {
        const b = player.blades[k];
        const br = 13 + EB.r[i];
        if ((b.x - x) ** 2 + (b.y - y) ** 2 < br * br) {
          poolRemove(EB, i--);
          hitBlade(k);
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      if (player.alive) {
        const rr = player.r * 0.7 + EB.r[i];
        if ((player.x - x) ** 2 + (player.y - y) ** 2 < rr * rr && player.inv <= 0 && player.dashT <= 0) {
          poolRemove(EB, i--);
          hurtPlayer(x, y);
        }
      }
    }
  }

  function updateGems(dt) {
    const magnet = game.between > 0 ? 4000 : S.magnet();
    for (let i = 0; i < G.n; i++) {
      G.age[i] += dt;
      const dx = player.x - G.x[i];
      const dy = player.y - G.y[i];
      const d = Math.hypot(dx, dy) || 1;
      // A shard locks on the moment it is inside the magnet (even while it is still
      // popping out of the explosion), and stays locked even if you dash away.
      if (player.alive && !G.lock[i] && d < magnet) G.lock[i] = 1;
      let reached = false;
      if (player.alive && G.lock[i] && G.age[i] > 0.25) {
        // Home straight in. Position moves directly at the ship each frame, so it
        // can never overshoot or orbit; it speeds up the longer it chases, so it
        // always outruns the ship, even mid-dash.
        G.lock[i] += dt;
        const step = (520 + 2600 * (G.lock[i] - 1)) * dt;
        if (step >= d - player.r) {
          reached = true;
        } else {
          G.x[i] += (dx / d) * step;
          G.y[i] += (dy / d) * step;
        }
      } else {
        // Loose shards drift and slow down (the pop out of an explosion).
        G.vx[i] *= Math.max(0, 1 - 3 * dt);
        G.vy[i] *= Math.max(0, 1 - 3 * dt);
        G.x[i] += G.vx[i] * dt;
        G.y[i] += G.vy[i] * dt;
      }
      const after = Math.hypot(player.x - G.x[i], player.y - G.y[i]);
      if (player.alive && G.age[i] > 0.2 && (reached || after < player.r + 10)) {
        gainXp(G.val[i]);
        particle(G.x[i], G.y[i], 0, -60, 0.25, 2, C.green, 1);
        poolRemove(G, i--);
        sfx.pickup();
      } else if (G.age[i] > 25) {
        poolRemove(G, i--);
      }
    }
  }

  // Orbit radius grows past 4 blades so they don't overlap.
  function bladeRadius(n) {
    return 78 + 7 * Math.max(0, n - 4);
  }

  function placeBlades() {
    const list = player.blades;
    const n = list.length;
    const R = bladeRadius(n);
    for (let k = 0; k < n; k++) {
      const a = player.bladeAng + (k / n) * TAU;
      list[k].x = player.x + Math.cos(a) * R;
      list[k].y = player.y + Math.sin(a) * R;
    }
  }

  // An enemy bullet hit blade k: chip it, and break it once it runs out of hits.
  function hitBlade(k) {
    const blade = player.blades[k];
    blade.hp--;
    blade.hitT = 0.12;
    burst(blade.x, blade.y, C.orange, 6, 220, 0.3, 1.6);
    if (blade.hp > 0) {
      sfx.pickup();
      return;
    }
    player.blades.splice(k, 1);
    player.up.orbit = player.blades.length;
    burst(blade.x, blade.y, C.cyan, 30, 420, 0.6, 2.4);
    burst(blade.x, blade.y, C.white, 12, 300, 0.4, 2);
    ring(blade.x, blade.y, 120, C.cyan, 0.4, 4);
    floatText(blade.x, blade.y - 18, "BLADE LOST", C.red);
    addShake(0.25);
    sfx.kill(false);
    placeBlades();
  }

  function updateBlades(dt) {
    const n = S.blades();
    if (!n || !player.alive) return;
    player.bladeAng += dt * 4.8;
    placeBlades();
    for (let k = 0; k < n; k++) {
      const blade = player.blades[k];
      blade.hitT = Math.max(0, blade.hitT - dt);
      const a = player.bladeAng + (k / n) * TAU;
      const bx = blade.x;
      const by = blade.y;
      nearby(bx, by, 14, (e) => {
        if (e.blade > 0) return true;
        const rr = e.r + 12;
        if ((e.x - bx) ** 2 + (e.y - by) ** 2 < rr * rr) {
          e.blade = 0.3;
          burst(bx, by, C.cyan, 4, 200, 0.25, 1.6);
          damageEnemy(e, 2 + stat("power"), Math.cos(a + 1.57), Math.sin(a + 1.57), 140);
        }
        return true;
      });
    }

    // Blade guns: blades take turns firing, so each one shoots at half the
    // ship's fire rate. They use the ship's damage, pierce and fire-rate
    // upgrades, and get +1 bullet for every 2 Split Beam picks.
    player.bladeFireT -= dt;
    const period = 2 / S.fireRate() / n;
    for (let guard = 0; guard < 4 && player.bladeFireT <= 0; guard++) {
      const k = player.bladeNext % n;
      const bx = player.blades[k].x;
      const by = player.blades[k].y;
      const target = nearestEnemy(bx, by, 650);
      if (!target) {
        player.bladeFireT = 0; // nothing in range: wait, don't bank shots
        break;
      }
      player.bladeNext++;
      player.bladeFireT += period;
      const shots = 1 + Math.floor(stat("spread") / 2);
      const aim = Math.atan2(target.y - by, target.x - bx);
      for (let s = 0; s < shots; s++) spawnBullet(bx, by, aim + (s - (shots - 1) / 2) * 0.13, 900, 1);
      particle(bx, by, Math.cos(aim) * 160, Math.sin(aim) * 160, 0.12, 2, C.cyan, 6);
    }
  }

  function nearestEnemy(x, y, range) {
    let best = range * range;
    let found = null;
    for (const e of enemies) {
      if (e.dead || e.born > 0.2) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < best) {
        best = d;
        found = e;
      }
    }
    return found;
  }

  function gainXp(v) {
    player.xp += v;
    let need = XP_TABLE[Math.min(player.level - 1, XP_TABLE.length - 1)];
    while (player.xp >= need) {
      player.xp -= need;
      player.level++;
      game.pendingLevels++;
      need = XP_TABLE[Math.min(player.level - 1, XP_TABLE.length - 1)];
    }
  }

  // ---------- rendering ----------
  const SHAPES = {
    drifter: { sides: 4, stretch: 1 },
    dart: { sides: 3, stretch: 1.5 },
    splitter: { sides: 4, stretch: 1 },
    shard: { sides: 3, stretch: 1 },
    orbiter: { sides: 0, stretch: 1 },
    tank: { sides: 8, stretch: 1 },
    hive: { sides: 6, stretch: 1 },
  };

  function polyPath(x, y, r, sides, ang, stretch = 1) {
    for (let k = 0; k <= sides; k++) {
      const a = ang + (k / sides) * TAU;
      const rr = k % sides === 0 ? r * stretch : r;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }

  function enemyPath(e, r) {
    const shape = SHAPES[e.kind];
    if (!shape.sides) {
      ctx.moveTo(e.x + r, e.y);
      ctx.arc(e.x, e.y, r, 0, TAU);
      ctx.moveTo(e.x + r * 0.45, e.y);
      ctx.arc(e.x, e.y, r * 0.45, 0, TAU);
      return;
    }
    const ang = e.kind === "dart" ? e.ang : e.ang;
    polyPath(e.x, e.y, r, shape.sides, ang, shape.stretch);
    if (e.kind === "splitter") polyPath(e.x, e.y, r * 0.5, 4, -ang * 1.5);
    if (e.kind === "tank") polyPath(e.x, e.y, r * 0.55, 8, -ang);
    if (e.kind === "hive") {
      polyPath(e.x, e.y, r * 0.62, 6, -ang * 1.3);
      polyPath(e.x, e.y, r * 0.28, 6, ang * 2);
      for (let k = 0; k < 6; k++) {
        const a = e.t * 1.4 + (k / 6) * TAU;
        const cx = e.x + Math.cos(a) * r * 1.35;
        const cy = e.y + Math.sin(a) * r * 1.35;
        polyPath(cx, cy, 9, 6, a);
      }
    }
  }

  function render(realDt) {
    // camera follows the player, eased; the arena is centered when the view is bigger
    const halfW = vw / 2 / scale;
    const halfH = vh / 2 / scale;
    const lerp = Math.min(1, realDt * 7);
    cam.x += (player.x - cam.x) * lerp;
    cam.y += (player.y - cam.y) * lerp;
    cam.x = halfW * 2 >= ARENA ? ARENA / 2 : clamp(cam.x, halfW - 60, ARENA - halfW + 60);
    cam.y = halfH * 2 >= ARENA ? ARENA / 2 : clamp(cam.y, halfH - 60, ARENA - halfH + 60);

    let sx = 0;
    let sy = 0;
    if (game.shake > 0) {
      const s = game.shake * game.shake * 16;
      sx = rand(-s, s);
      sy = rand(-s, s);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#05030f";
    ctx.fillRect(0, 0, vw, vh);

    // parallax stars
    for (let layer = 0; layer < q.stars; layer++) {
      const tile = starTiles[layer];
      const f = layer ? 0.35 : 0.15;
      const ox = -((((cam.x * f * scale) % 1024) + 1024) % 1024);
      const oy = -((((cam.y * f * scale) % 1024) + 1024) % 1024);
      ctx.globalAlpha = layer ? 0.9 : 0.7;
      for (let x = ox; x < vw; x += 1024) for (let y = oy; y < vh; y += 1024) ctx.drawImage(tile, x, y);
    }

    // world space
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (vw / 2 + sx - cam.x * scale), dpr * (vh / 2 + sy - cam.y * scale));
    const x0 = cam.x - halfW;
    const y0 = cam.y - halfH;
    const x1 = cam.x + halfW;
    const y1 = cam.y + halfH;

    ctx.globalAlpha = 1;
    if (q.grid) drawGrid(x0, y0, x1, y1);

    // arena wall
    ctx.lineWidth = 10;
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#ff4fd8";
    ctx.strokeRect(-4, -4, ARENA + 8, ARENA + 8);
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.95;
    ctx.strokeRect(0, 0, ARENA, ARENA);

    ctx.globalCompositeOperation = "lighter";

    // telegraphs: pulsing warning reticles where enemies are about to appear
    for (const tg of game.telegraphs) {
      const col = KIND_COLOR[tg.kind];
      const r = ENEMY[tg.kind].radius;
      const pulse = 0.5 + 0.5 * Math.sin(game.time * 22);
      drawGlow(col, tg.x, tg.y, r * 3, 0.3 + pulse * 0.3);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = COLORS[col];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tg.x, tg.y, r + tg.t * 40, 0, TAU);
      ctx.stroke();
    }

    // XP shards
    if (G.n) {
      for (let i = 0; i < G.n; i++) {
        if (G.x[i] < x0 - 20 || G.x[i] > x1 + 20 || G.y[i] < y0 - 20 || G.y[i] > y1 + 20) continue;
        drawGlow(C.green, G.x[i], G.y[i], G.val[i] > 1 ? 30 : 20, 0.7);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#c8ffbf";
      ctx.beginPath();
      for (let i = 0; i < G.n; i++) {
        const s = G.val[i] > 1 ? 9 : 6;
        const x = G.x[i];
        const y = G.y[i];
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.7, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s * 0.7, y);
        ctx.closePath();
      }
      ctx.fill();
    }

    // enemy glows
    for (const e of enemies) {
      if (e.x < x0 - 80 || e.x > x1 + 80 || e.y < y0 - 80 || e.y > y1 + 80) continue;
      const pop = e.born > 0 ? 1 + e.born * 2 : 1;
      drawGlow(e.col, e.x, e.y, e.r * 3.2 * pop, e.kind === "hive" ? 0.9 : 0.55);
    }
    // enemy bodies, batched by kind (and a white batch for hit flashes)
    ctx.globalCompositeOperation = "source-over";
    ctx.lineJoin = "round";
    for (const kind in SHAPES) {
      let any = false;
      ctx.beginPath();
      for (const e of enemies) {
        if (e.kind !== kind || (e.flash > 0 && e.r <= 20)) continue;
        if (e.x < x0 - 80 || e.x > x1 + 80 || e.y < y0 - 80 || e.y > y1 + 80) continue;
        const r = e.r * (e.born > 0 ? 1 - e.born : 1);
        enemyPath(e, r);
        any = true;
      }
      if (!any) continue;
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = ENEMY[kind].color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = kind === "tank" || kind === "hive" ? 4 : 2.6;
      ctx.strokeStyle = ENEMY[kind].color;
      ctx.stroke();
    }
    // hit flash: small enemies flash solid white, big ones just get a white outline
    ctx.beginPath();
    let flashing = false;
    for (const e of enemies) {
      if (e.flash <= 0 || e.r > 20) continue;
      enemyPath(e, e.r * 1.08);
      flashing = true;
    }
    ctx.globalAlpha = 1;
    if (flashing) {
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
    ctx.beginPath();
    flashing = false;
    for (const e of enemies) {
      if (e.flash <= 0 || e.r <= 20) continue;
      enemyPath(e, e.r);
      flashing = true;
    }
    if (flashing) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }

    // dart charge lines (telegraph where it will fly)
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "#ffe14d";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    for (const e of enemies) {
      if (e.kind !== "dart" || e.state !== 0 || e.timer > 0.45) continue;
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x + Math.cos(e.ang) * 260, e.y + Math.sin(e.ang) * 260);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalCompositeOperation = "lighter";

    // enemy bullets
    for (let i = 0; i < EB.n; i++) drawGlow(C.purple, EB.x[i], EB.y[i], 20, 0.8);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#f0e6ff";
    ctx.beginPath();
    for (let i = 0; i < EB.n; i++) {
      ctx.moveTo(EB.x[i] + 4, EB.y[i]);
      ctx.arc(EB.x[i], EB.y[i], 4, 0, TAU);
    }
    ctx.fill();

    // player bullets: glow + bright streak (yellow from the ship, cyan from blades)
    for (let i = 0; i < B.n; i++) drawGlow(B.kind[i] ? C.cyan : C.yellow, B.x[i], B.y[i], B.kind[i] ? 18 : 22, 0.65);
    ctx.globalAlpha = 1;
    ctx.lineCap = "round";
    for (let kind = 0; kind < 2; kind++) {
      ctx.strokeStyle = kind ? "#d8fdff" : "#fff6c2";
      ctx.lineWidth = kind ? 2.5 : 3;
      ctx.beginPath();
      for (let i = 0; i < B.n; i++) {
        if (B.kind[i] !== kind) continue;
        ctx.moveTo(B.x[i], B.y[i]);
        ctx.lineTo(B.x[i] - B.vx[i] * 0.018, B.y[i] - B.vy[i] * 0.018);
      }
      ctx.stroke();
    }

    // particles
    drawParticles();

    // shockwave rings
    for (const r of game.rings) {
      ctx.globalAlpha = Math.max(0, r.life / r.max);
      ctx.strokeStyle = COLORS[r.col];
      ctx.lineWidth = r.width;
      ctx.beginPath();
      ctx.arc(r.x, r.y, Math.max(0.1, r.r), 0, TAU);
      ctx.stroke();
    }

    // orbit blades
    const nb = S.blades();
    if (nb && player.alive && game.mode !== "menu") {
      for (let k = 0; k < nb; k++) {
        const blade = player.blades[k];
        // Color shows how many hits it has left: cyan, then yellow, then red.
        const left = blade.hp / CONFIG.blade_hp;
        const col = left > 0.6 ? C.cyan : left > 0.3 ? C.yellow : C.red;
        drawGlow(col, blade.x, blade.y, 34, 0.7);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = blade.hitT > 0 ? "#ffffff" : left > 0.6 ? "#d8fdff" : COLORS[col];
        ctx.lineWidth = 3;
        ctx.beginPath();
        polyPath(blade.x, blade.y, 11, 3, player.bladeAng * 3 + k);
        ctx.stroke();
      }
    }

    // player ship
    if (player.alive && game.mode !== "menu") {
      const blink = player.inv > 0 && Math.floor(game.time * 20) % 2 === 0;
      if (!blink) {
        drawGlow(player.dashT > 0 ? C.white : C.cyan, player.x, player.y, 60, 0.75);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        const a = player.ang;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const pt = (fx, fy) => [player.x + fx * ca - fy * sa, player.y + fx * sa + fy * ca];
        ctx.beginPath();
        const nose = pt(20, 0);
        const lw = pt(-12, 13);
        const notch = pt(-5, 0);
        const rw = pt(-12, -13);
        ctx.moveTo(nose[0], nose[1]);
        ctx.lineTo(lw[0], lw[1]);
        ctx.lineTo(notch[0], notch[1]);
        ctx.lineTo(rw[0], rw[1]);
        ctx.closePath();
        ctx.fillStyle = "#0b2a3a";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = player.dashT > 0 ? "#ffffff" : "#33f0ff";
        ctx.stroke();
        ctx.globalCompositeOperation = "lighter";
        // shield bubble shows how many hits you have left
        if (player.shields > 0) {
          ctx.globalAlpha = 0.25 + 0.08 * player.shields;
          ctx.strokeStyle = "#33f0ff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(player.x, player.y, 26, 0, TAU);
          ctx.stroke();
        }
      }
    }

    // floating score text
    ctx.globalCompositeOperation = "source-over";
    ctx.font = "700 20px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    for (const t of game.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 2);
      ctx.fillStyle = COLORS[t.col];
      ctx.fillText(t.text, t.x, t.y);
    }

    // screen space overlays
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(vignette, 0, 0, vw, vh);
    if (game.flash > 0) {
      ctx.globalAlpha = Math.min(0.5, game.flash);
      ctx.fillStyle = player.alive ? "#ff3b5c" : "#ffffff";
      ctx.fillRect(0, 0, vw, vh);
    }

    // virtual stick
    const st = input.stick;
    if (st && game.mode === "play") {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = "#33f0ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(st.ox, st.oy, 56, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.drawImage(glow(C.cyan), st.x - 34, st.y - 34, 68, 68);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
  }

  // ---------- HUD (DOM, touched only when values change) ----------
  const hudCache = {};
  function setText(id, value) {
    if (hudCache[id] !== value) {
      hudCache[id] = value;
      document.getElementById(id).textContent = value;
    }
  }

  function updateHud(force) {
    setText("score", fmt(game.score));
    const mult = comboMult();
    const comboText = game.combo >= 6 ? `×${mult.toFixed(1)} COMBO ${game.combo}` : "";
    if (hudCache.combo !== comboText) {
      const el = $("#combo");
      el.classList.remove("pop");
      void el.offsetWidth;
      if (comboText) el.classList.add("pop");
    }
    setText("combo", comboText);
    setText("level", `LV ${player.level}`);
    const need = XP_TABLE[Math.min(player.level - 1, XP_TABLE.length - 1)];
    const xpScale = (player.xp / need).toFixed(3);
    if (hudCache.xp !== xpScale) {
      hudCache.xp = xpScale;
      $("#xp-fill").style.transform = `scaleX(${xpScale})`;
    }
    const shieldKey = `${player.shields}/${player.maxShields}`;
    if (force || hudCache.shields !== shieldKey) {
      hudCache.shields = shieldKey;
      // Up to 8 shields show as icons; past that, one icon and a count.
      $("#shields").innerHTML =
        player.maxShields <= 8
          ? Array.from({ length: player.maxShields }, (_, i) => `<i class="${i < player.shields ? "" : "empty"}"></i>`).join("")
          : `<i class="${player.shields ? "" : "empty"}"></i><span>${player.shields}/${player.maxShields}</span>`;
    }
    const boss = enemies.find((e) => e.kind === "hive" && !e.dead);
    $("#boss").hidden = !boss;
    if (boss) {
      const total = enemies.filter((e) => e.kind === "hive" && !e.dead).reduce((s, e) => s + Math.max(0, e.hp), 0);
      const max = enemies.filter((e) => e.kind === "hive" && !e.dead).reduce((s, e) => s + e.maxHp, 0);
      $("#boss-fill").style.transform = `scaleX(${(total / max).toFixed(3)})`;
    }
    const cd = player.dashCd > 0 ? Math.round((player.dashCd / S.dashCd()) * 100) : 0;
    if (hudCache.cd !== cd) {
      hudCache.cd = cd;
      $("#dash-ring").style.setProperty("--cd", `${cd}%`);
    }
  }

  let bannerTimer = 0;
  function showBanner(text, sub, boss, seconds) {
    const el = $("#banner");
    el.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ""}`;
    el.className = "banner";
    void el.offsetWidth;
    el.className = `banner show${boss ? " boss" : ""}`;
    el.style.animationDuration = `${seconds}s`;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (el.className = "banner"), seconds * 1000);
  }

  // ---------- level up ----------
  function openLevelUp() {
    game.mode = "levelup";
    game.pendingLevels--;
    sfx.level();
    burst(player.x, player.y, C.green, 40, 500, 0.8, 2.5);
    ring(player.x, player.y, 300, C.green, 0.6, 5);
    const shownLevel = player.level - game.pendingLevels;
    $("#levelup-num").textContent = shownLevel;
    // Every 5th level repairs shields.
    const bonus = $("#levelup-bonus");
    bonus.hidden = true;
    if (shownLevel % CONFIG.repair_every === 0) {
      const before = player.shields;
      player.shields = Math.min(player.maxShields, player.shields + CONFIG.repair_amount);
      const healed = player.shields - before;
      bonus.textContent = healed ? `Level ${shownLevel} bonus: +${healed} shield${healed > 1 ? "s" : ""} repaired` : `Level ${shownLevel} bonus: shields already full`;
      bonus.hidden = false;
      if (healed) {
        ring(player.x, player.y, 220, C.cyan, 0.7, 6);
        floatText(player.x, player.y - 34, `+${healed} 🛡`, C.cyan);
      }
      updateHud(true);
    }
    const open = Object.keys(UPG).filter((k) => UPG[k].max == null || (player.up[k] || 0) < UPG[k].max);
    const picks = [];
    while (picks.length < CONFIG.offer_size && open.length) picks.push(open.splice((Math.random() * open.length) | 0, 1)[0]);
    const cards = $("#cards");
    cards.innerHTML = "";
    if (!picks.length) {
      picks.push("__repair");
    }
    picks.forEach((key, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "card";
      if (key === "__repair") {
        btn.innerHTML = `<span class="key">${idx + 1}</span><span class="icon">🔧</span><b>Field Repair</b><p>Everything's maxed. Repair 1 shield and +500 score.</p>`;
      } else {
        const u = UPG[key];
        const have = player.up[key] || 0;
        const meter =
          u.max == null
            ? `<span class="tier">Rank ${have} → ${have + 1} · no limit</span>`
            : `<span class="pips">${Array.from({ length: u.max }, (_, i) => `<i class="${i < have ? "on" : i === have ? "new" : ""}"></i>`).join("")}</span>`;
        btn.innerHTML = `<span class="key">${idx + 1}</span><span class="icon">${u.icon}</span><b>${u.name}</b><p>${u.text}</p>${meter}`;
      }
      btn.addEventListener("click", () => pickUpgrade(key));
      cards.appendChild(btn);
    });
    $("#levelup").hidden = false;
    setTimeout(() => cards.firstChild && cards.firstChild.focus({ preventScroll: true }), 50);
  }

  function applyUpgrade(key) {
    player.up[key] = (player.up[key] || 0) + 1;
    if (key === "hull") {
      player.maxShields++;
      player.shields = Math.min(player.maxShields, player.shields + 1);
    }
    if (key === "orbit") {
      player.blades.push({ hp: CONFIG.blade_hp, x: player.x, y: player.y, hitT: 0 });
      player.up.orbit = player.blades.length;
      placeBlades();
    }
  }

  function pickUpgrade(key) {
    if (game.mode !== "levelup") return;
    if (key === "__repair") {
      player.shields = Math.min(player.maxShields, player.shields + 1);
      game.score += 500;
    } else {
      applyUpgrade(key);
    }
    $("#levelup").hidden = true;
    game.mode = "play";
    player.inv = Math.max(player.inv, 0.6);
    updateHud(true);
  }

  // ---------- pause / screens ----------
  function pause(on) {
    if (on && game.mode !== "play") return;
    if (!on && game.mode !== "pause") return;
    game.mode = on ? "pause" : "play";
    $("#pause").hidden = !on;
    if (on) {
      const owned = Object.entries(player.up).filter(([, v]) => v > 0);
      $("#owned").innerHTML = owned.length
        ? owned.map(([k, v]) => `<li>${UPG[k].icon} ${UPG[k].name} ×${v}</li>`).join("")
        : `<li class="none">No upgrades yet</li>`;
      $("#resume-btn").focus({ preventScroll: true });
    }
  }

  function boardKey(mode) {
    return mode === "daily" ? `neon-swarm:top:${CONFIG.daily}` : "neon-swarm:top:normal";
  }

  let boardMode = "normal";
  function renderBoard() {
    const list = store.get(boardKey(boardMode), []);
    $("#board-label").textContent = boardMode === "daily" ? CONFIG.daily.replace("daily-", "") : "Classic";
    $("#board").innerHTML = list.length
      ? list.map((r) => `<li><b>${escapeHtml(r.name)}</b><span>${fmt(r.score)} · W${r.wave}</span></li>`).join("")
      : `<li class="empty">No scores yet. Be the first.</li>`;
    document.querySelectorAll("[data-board]").forEach((b) => b.classList.toggle("on", b.dataset.board === boardMode));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function showMenu() {
    game.mode = "menu";
    for (const id of ["#hud", "#levelup", "#pause", "#over", "#dash-btn"]) $(id).hidden = true;
    $("#menu").hidden = false;
    renderBoard();
    resetWorld();
    // attract mode: a few harmless drifters wander behind the menu
    for (let k = 0; k < 14; k++) spawnEnemy(["drifter", "splitter", "orbiter", "dart"][k % 4], rand(200, 1400), rand(200, 1400)).born = 0;
  }

  function resetWorld() {
    enemies.forEach((e) => enemyPool.push(e));
    enemies.length = 0;
    B.n = 0;
    EB.n = 0;
    G.n = 0;
    P.n = 0;
    game.telegraphs = [];
    game.rings = [];
    game.texts = [];
    game.plan = null;
    game.nextPlan = null;
    game.groups = [];
    resetGrid();
    Object.assign(player, {
      x: ARENA / 2,
      y: ARENA / 2,
      vx: 0,
      vy: 0,
      ang: -Math.PI / 2,
      shields: 3,
      maxShields: 3,
      inv: 0,
      dashT: 0,
      dashCd: 0,
      fireT: 0,
      blades: [],
      bladeFireT: 0,
      bladeNext: 0,
      level: 1,
      xp: 0,
      up: {},
      alive: true,
    });
    cam.x = player.x;
    cam.y = player.y;
  }

  let starting = false;
  async function startRun(daily) {
    if (starting) return;
    starting = true;
    sfx.unlock();
    const btn = daily ? $("#daily-btn") : $("#play-btn");
    const label = btn.innerHTML;
    btn.textContent = "Loading…";
    try {
      const run = await api.run(daily);
      resetWorld();
      shotCount[0] = 0;
      shotCount[1] = 0;
      Object.assign(game, { seed: run.seed, daily: run.daily, score: 0, kills: 0, combo: 0, comboT: 0, time: 0, pendingLevels: 0, slow: 0, slowScale: 1, shake: 0, flash: 0, wave: 0 });
      for (const k in hudCache) delete hudCache[k];
      input.mouseT = -99;
      $("#menu").hidden = true;
      $("#over").hidden = true;
      $("#hud").hidden = false;
      $("#dash-btn").hidden = false;
      game.mode = "play";
      updateHud(true);
      startWave(run.first);
    } catch {
      showBanner("OFFLINE", "the server is waking up, try again", false, 2.5);
    } finally {
      btn.innerHTML = label;
      starting = false;
    }
  }

  function gameOver() {
    game.mode = "over";
    $("#dash-btn").hidden = true;
    $("#over-score").textContent = fmt(game.score);
    const mins = Math.floor(game.time / 60);
    const secs = String(Math.floor(game.time % 60)).padStart(2, "0");
    $("#over-stats").innerHTML = [
      ["Wave", game.wave],
      ["Level", player.level],
      ["Kills", fmt(game.kills)],
      ["Time", `${mins}:${secs}`],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join("");
    const key = boardKey(game.daily ? "daily" : "normal");
    const list = store.get(key, []);
    const qualifies = game.score > 0 && (list.length < 10 || game.score > list[list.length - 1].score);
    const form = $("#initials-form");
    form.hidden = !qualifies;
    form.dataset.key = key;
    $("#over").hidden = false;
    if (qualifies) {
      const input = $("#initials");
      input.value = store.get("neon-swarm:initials", "");
      setTimeout(() => input.focus(), 60);
    } else {
      $("#again-btn").focus({ preventScroll: true });
    }
  }

  $("#initials-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#initials").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "???";
    store.set("neon-swarm:initials", name);
    const key = e.currentTarget.dataset.key;
    const list = store.get(key, []);
    list.push({ name, score: game.score, wave: game.wave });
    list.sort((a, b) => b.score - a.score);
    store.set(key, list.slice(0, 10));
    e.currentTarget.hidden = true;
    boardMode = game.daily ? "daily" : "normal";
    showBanner("SAVED", name, false, 1.2);
    $("#again-btn").focus({ preventScroll: true });
  });

  // ---------- menu wiring ----------
  $("#play-btn").addEventListener("click", () => startRun(false));
  $("#daily-btn").addEventListener("click", () => startRun(true));
  $("#again-btn").addEventListener("click", () => startRun(game.daily));
  $("#menu-btn").addEventListener("click", showMenu);
  $("#resume-btn").addEventListener("click", () => pause(false));
  $("#quit-btn").addEventListener("click", showMenu);
  $("#pause-btn").addEventListener("click", () => pause(true));
  document.querySelectorAll("[data-board]").forEach((b) =>
    b.addEventListener("click", () => {
      boardMode = b.dataset.board;
      renderBoard();
    }),
  );
  $("#daily-date").textContent = CONFIG.daily.replace("daily-", "");
  $("#quality").value = String(settings.quality);
  $("#quality").addEventListener("change", (e) => {
    settings.quality = e.target.value;
    store.set("neon-swarm:quality", settings.quality);
    setQuality(settings.quality === "auto" ? 2 : Number(settings.quality));
  });
  $("#shake-opt").checked = settings.shake && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  settings.shake = $("#shake-opt").checked;
  $("#shake-opt").addEventListener("change", (e) => {
    settings.shake = e.target.checked;
    store.set("neon-swarm:shake", settings.shake);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause(true);
    music.suspend(document.hidden);
  });

  function setMusic(on) {
    settings.music = on;
    store.set("neon-swarm:music", on);
    $("#music-opt").checked = on;
    music.refresh();
    if (game.mode !== "menu") showBanner(on ? "MUSIC ON" : "MUSIC OFF", "", false, 0.8);
  }
  $("#music-opt").checked = settings.music;
  $("#music-opt").addEventListener("change", (e) => setMusic(e.target.checked));

  // Browsers only allow sound after the first tap/click/key, so music starts then.
  const startAudio = () => {
    sfx.unlock();
    updateMusic();
  };
  window.addEventListener("pointerdown", startAudio, { once: true, capture: true });
  window.addEventListener("keydown", startAudio, { once: true, capture: true });

  // Pick the track for what's on screen: menu, normal waves, or a Hive fight.
  function updateMusic() {
    if (!audioStarted()) return;
    let track = "calm";
    let boss = null;
    if (game.mode !== "menu" && !(game.mode === "over" && game.overT <= 0)) {
      for (const e of enemies) if (e.kind === "hive" && !e.dead) boss = e;
      const incoming = game.telegraphs.some((tg) => tg.kind === "hive");
      track = boss || incoming ? "boss" : "play";
    }
    music.play(track);
    music.intensity(boss && boss.hp < boss.maxHp / 2 ? 1 : 0);
    music.duck(game.mode === "pause" || game.mode === "levelup" ? 0.45 : 1);
  }

  let audioOk = false;
  function audioStarted() {
    if (!audioOk) {
      const ctx = sfx.context();
      audioOk = !!ctx && ctx.state !== "suspended";
      if (ctx && ctx.state === "suspended") ctx.resume().then(() => (audioOk = true)).catch(() => {});
    }
    return audioOk;
  }

  // enemy codex with tiny live-drawn icons
  $("#codex").innerHTML = Object.entries(ENEMY)
    .filter(([k]) => k !== "shard")
    .sort((a, b) => a[1].from_wave - b[1].from_wave)
    .map(([k, e]) => `<li><canvas data-kind="${k}" width="52" height="52"></canvas><div><b style="color:${e.color}">${e.name}</b><span>${e.about}</span></div></li>`)
    .join("");
  document.querySelectorAll("#codex canvas").forEach((c) => {
    const g = c.getContext("2d");
    const kind = c.dataset.kind;
    const info = ENEMY[kind];
    const shape = SHAPES[kind];
    g.translate(26, 26);
    g.drawImage(glow(KIND_COLOR[kind]), -26, -26, 52, 52);
    g.strokeStyle = info.color;
    g.lineWidth = 3;
    g.beginPath();
    if (!shape.sides) g.arc(0, 0, 13, 0, TAU);
    else
      for (let k = 0; k <= shape.sides; k++) {
        const a = -Math.PI / 2 + (k / shape.sides) * TAU;
        const r = k % shape.sides === 0 ? 14 * shape.stretch : 14;
        g[k ? "lineTo" : "moveTo"](Math.cos(a) * Math.min(r, 20), Math.sin(a) * Math.min(r, 20));
      }
    g.stroke();
  });

  // ---------- frame loop + adaptive quality ----------
  function setQuality(level) {
    qLevel = level;
    q = QUALITY[level];
    resize();
  }

  let last = performance.now();
  let slowFrames = 0; // ms of recent slow frames
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fpsShown = 0;
  let workMs = 0; // smoothed CPU time per frame (update + draw)
  const frameTimes = new Float32Array(120);
  let frameIdx = 0;

  function frame(now) {
    const realDt = Math.min(0.05, (now - last) / 1000);
    const rawMs = now - last;
    last = now;
    frameTimes[frameIdx++ % frameTimes.length] = rawMs;

    // Auto quality: if most recent frames take > 22 ms (under ~45 fps), step down.
    if (settings.quality === "auto" && game.mode === "play" && document.visibilityState === "visible") {
      // count *time* spent in slow frames, so weak devices react within ~1.5 s
      slowFrames = rawMs > 22 && rawMs < 250 ? slowFrames + rawMs : Math.max(0, slowFrames - rawMs);
      if (slowFrames > 1500 && qLevel > 0) {
        slowFrames = 0;
        setQuality(qLevel - 1);
      }
    }

    let dt = realDt;
    if (game.slow > 0) {
      game.slow -= realDt;
      dt *= game.slowScale;
      if (game.slow <= 0) game.slowScale = 1;
    }
    game.shake = Math.max(0, game.shake - realDt * 2.2);
    game.flash = Math.max(0, game.flash - realDt * 1.5);

    if (game.mode === "play" || game.mode === "menu" || (game.mode === "over" && game.overT > 0)) {
      // two half-steps when the frame is long keeps fast things from tunneling
      if (dt > 1 / 50) {
        update(dt / 2);
        update(dt / 2);
      } else {
        update(dt);
      }
      if (game.mode === "menu") {
        player.x = ARENA / 2 + Math.cos(game.time * 0.2) * 300;
        player.y = ARENA / 2 + Math.sin(game.time * 0.27) * 300;
      }
      if (game.mode === "play") {
        updateHud(false);
        if (game.pendingLevels > 0 && player.alive) openLevelUp();
        if (!player.alive) {
          game.overT -= realDt;
          if (game.overT <= 0) gameOver();
        }
      }
    }
    render(realDt);
    if (audioOk) updateMusic();
    workMs += (performance.now() - now - workMs) * 0.05;

    fpsAcc += rawMs;
    fpsFrames++;
    if (fpsAcc > 500) {
      fpsShown = Math.round((1000 * fpsFrames) / fpsAcc);
      fpsAcc = 0;
      fpsFrames = 0;
      if (settings.fps) $("#fps").textContent = `${fpsShown} fps · ${workMs.toFixed(1)} ms · ${QUALITY[qLevel].name} · ${P.n} particles · ${enemies.length} enemies`;
    }
    requestAnimationFrame(frame);
  }

  // Test/debug hooks (read-only snapshot plus a couple of switches).
  window.__neon = {
    snapshot: () => ({
      mode: game.mode,
      wave: game.wave,
      score: game.score,
      kills: game.kills,
      level: player.level,
      shields: player.shields,
      enemies: enemies.length,
      particles: P.n,
      gems: G.n,
      music: music.state(),
      maxShields: player.maxShields,
      shipShots: shotCount[0],
      bladeShots: shotCount[1],
      bladeHp: player.blades.map((b) => b.hp),
      lockedGems: Array.from(G.lock.subarray(0, G.n)).filter(Boolean).length,
      gemInfo: Array.from({ length: G.n }, (_, i) => [Math.round(Math.hypot(G.x[i] - player.x, G.y[i] - player.y)), +G.lock[i].toFixed(2), +G.age[i].toFixed(2)]),
      bullets: B.n,
      quality: QUALITY[qLevel].name,
      fps: fpsShown,
      workMs: Math.round(workMs * 100) / 100,
      seed: game.seed,
      upgrades: { ...player.up },
      frameTimes: Array.from(frameTimes),
    }),
    giveXp: (n) => gainXp(n),
    sfxOff: (off) => {
      settings.sfxOff = off; // tests only: hear the music without effects
    },
    // Fire an enemy bullet straight at blade k (for tests).
    shootBlade: (k) => {
      const b = player.blades[k];
      const a = Math.atan2(b.y - player.y, b.x - player.x);
      enemyShot(b.x + Math.cos(a) * 40, b.y + Math.sin(a) * 40, a + Math.PI, 600);
    },
    grant: (key, times = 1) => {
      for (let k = 0; k < times; k++) applyUpgrade(key);
      updateHud(true);
    },
    // Scatter n single-XP shards in a ring around the ship (for tests).
    dropXpAround: (n, dist) => {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU;
        dropXp(player.x + Math.cos(a) * dist, player.y + Math.sin(a) * dist, 1);
      }
    },
    hurt: () => {
      player.inv = 0;
      player.dashT = 0;
      hurtPlayer(player.x + 1, player.y);
    },
    setShields: (n) => {
      player.shields = n;
    },
    jumpTo: async (n) => {
      enemies.forEach((e) => (e.dead = true));
      game.telegraphs = [];
      startWave(await api.wave(game.seed, n));
    },
  };

  window.addEventListener("resize", resize);
  resize();
  resetGrid();
  showMenu();
  requestAnimationFrame(frame);
})();
