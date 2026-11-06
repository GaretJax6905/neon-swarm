# Neon Swarm

**▶ Play it: https://neon-swarm.onrender.com** (free hosting: the first visit after a quiet spell can take ~30–60 s to wake up)

A neon arena survival shooter in the browser. Fly a tiny ship around a glowing arena, mow down endless swarms, grab green shards to level up, stack upgrades, and survive **The Hive** every 10 waves.

- **▶ Play:** a fresh random run every time.
- **☀ Daily Run:** everyone gets the exact same waves until midnight UTC. Compare scores.
- Works with keyboard + mouse or touch, and installs to a phone home screen (PWA).

A sister project to [RPS Chaos](https://github.com/GaretJax6905/rps-chaos), built with Claude (AI) as a coding partner.

## Controls

| Action | Keyboard / mouse | Phone |
| --- | --- | --- |
| Move | `WASD` / arrow keys | Drag anywhere (floating joystick) |
| Aim + fire | Point the mouse (fires automatically) | Automatic: nearest enemy |
| Dash (invincible) | `Space`, `Shift` or right-click | DASH button |
| Pick an upgrade | `1` `2` `3` or click | Tap a card |
| Pause / mute / FPS | `P` / `M` / `F` | ❚❚ button |

If you stop moving the mouse for a couple of seconds, auto-aim takes over.

## The swarm

| Enemy | From wave | Behavior |
| --- | --- | --- |
| 🔷 Drifter | 1 | Wobbles straight at you |
| 🔺 Dart | 3 | Aims (dashed line), pauses, then charges |
| 🟪 Splitter | 5 | Bursts into three fast Shards |
| 🟣 Orbiter | 7 | Circles at range and fires plasma |
| 🛑 Bulwark | 9 | Slow, armored, shoves you back |
| ⬢ **The Hive** | every 10th | Boss: bullet rings, spawns Drifters, enrages at half HP (one more Hive each lap) |

Enemies get +8% HP and +2% speed per wave (speed caps at +60%). Kills chain into a combo multiplier (up to ×5). Getting hit costs a shield; with no shields left, the next hit ends the run.

## Upgrades

Overclock (fire rate), Split Beam (more bullets), Phase Rounds (pierce), Hot Plasma (damage), Thrusters (speed), Tractor Field (pickup range), Reinforced Hull (+1 shield), Blink Drive (dash cooldown), Orbit Blades, Nova Core (dash shockwave). Each has a max; once everything is maxed you get Field Repair instead.

## How it stays smooth (60 fps on phones)

- **No `shadowBlur`.** Every glow is a pre-rendered radial-gradient sprite drawn with additive blending (`globalCompositeOperation = "lighter"`).
- **Typed-array pools** for particles, bullets and XP shards: nothing is allocated per frame, so there are no garbage-collection hitches.
- **Batched drawing.** All same-colored shapes go in one path and get stroked once (e.g. ~27 strokes for up to 2,400 particles).
- **Spatial grid collisions** instead of checking every bullet against every enemy.
- **Auto graphics:** if frames run long for ~1.5 s, it steps down High → Medium → Low (lower resolution, fewer particles, no warping grid). You can also pick a level on the menu.
- The background grid is a spring mesh: explosions push it and the ripple spreads.

Measured in headless Chrome: a locked 60 fps on desktop; a phone viewport with the CPU throttled 4× during a wave-30 boss fight stayed at 30–55 fps after auto-dropping to Low.

## How it's built

| File | Job |
| --- | --- |
| `waves.py` | Wave director: seed + wave number → spawn plan (deterministic, so Daily Runs match) |
| `upgrades.py` | The upgrade list, caps and XP curve |
| `app.py` | Flask: the page, `/api/run`, `/api/wave`, `/api/config`, PWA files |
| `static/game.js` | Canvas engine: simulation, rendering, input, HUD, audio (WebAudio synth, no sound files) |
| `tests/` | unit, integration (Flask test client) and e2e (real Chromium via Playwright) |

The browser prefetches the next wave's plan while you fight the current one, so there's no pause between waves.

High scores are an arcade-style top 10 per device (browser local storage): one board for normal runs and one per Daily Run.

## Run it locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install --with-deps chromium
python run.py
```

Open http://127.0.0.1:5050. To play from your phone on the same Wi-Fi: `HOST=0.0.0.0 python run.py`, then open `http://<your-computer's-IP>:5050`.

## Checks

```bash
python check.py          # Black, Pylint, pytest, and real-browser tests
python check.py --fast   # skip the browser tests
```

GitHub Actions runs the same `check.py` on every push and pull request.

## Deploy (Render)

`render.yaml` is a Render Blueprint: free plan, one gunicorn worker, auto-deploys from `main`. The app is stateless, so restarts lose nothing.
