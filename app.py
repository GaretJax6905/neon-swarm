"""Flask web layer: one page plus a small JSON API for wave plans.

The game itself runs in the browser on a <canvas>. Python decides what each
wave contains (waves.py) and owns the list of upgrades (upgrades.py).
"""

import datetime
import secrets

from flask import Flask, jsonify, render_template, request, send_from_directory

import upgrades
import waves

app = Flask(__name__)


def today():
    """Today's date in UTC (tests replace this to pin the Daily Run)."""
    return datetime.datetime.now(datetime.timezone.utc).date()


def daily_seed():
    """Everyone shares this seed until midnight UTC."""
    return f"daily-{today().isoformat()}"


def _error(message, status=400):
    return jsonify({"error": message}), status


@app.errorhandler(waves.WaveError)
def _wave_error(problem):
    return _error(str(problem))


def _config():
    """Everything the browser needs before the first frame."""
    return {
        "enemies": waves.ENEMIES,
        "upgrades": upgrades.UPGRADES,
        "offer_size": upgrades.OFFER_SIZE,
        "xp_table": [upgrades.xp_to_next(level) for level in range(1, 101)],
        "boss_every": waves.BOSS_EVERY,
        "daily": daily_seed(),
    }


# ---------- pages ----------


@app.get("/")
def index():
    """Serve the single-page game."""
    return render_template("index.html", config=_config())


@app.get("/manifest.webmanifest")
def manifest():
    """Web app manifest so phones can install the game."""
    return send_from_directory(
        app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json"
    )


@app.get("/sw.js")
def service_worker():
    """Service worker served from the root so it controls every page."""
    response = send_from_directory(app.static_folder, "sw.js")
    response.headers["Cache-Control"] = "no-cache"
    return response


# ---------- API ----------


@app.get("/api/config")
def config():
    """Same data that is embedded in the page, for scripts and tests."""
    return jsonify(_config())


@app.post("/api/run")
def new_run():
    """Start a run: the Daily seed, or a fresh random one."""
    body = request.get_json(silent=True)
    daily = isinstance(body, dict) and body.get("daily") is True
    seed = daily_seed() if daily else f"run-{secrets.token_hex(6)}"
    return jsonify({"seed": seed, "daily": daily, "first": waves.plan(seed, 1)})


@app.get("/api/wave")
def wave():
    """Spawn plan for wave ?n= of run ?seed=."""
    return jsonify(waves.plan(request.args.get("seed"), request.args.get("n")))
