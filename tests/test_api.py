"""Flask request/response checks with no real browser."""

# pytest injects fixtures by name.
# pylint: disable=redefined-outer-name

import datetime

import pytest

import app as web

pytestmark = pytest.mark.integration


@pytest.fixture
def client(monkeypatch):
    """A test client with the Daily Run pinned to one date."""
    monkeypatch.setattr(web, "today", lambda: datetime.date(2026, 11, 6))
    web.app.config["TESTING"] = True
    return web.app.test_client()


def test_page_embeds_config(client):
    """The page ships the enemy and upgrade data the canvas needs."""
    res = client.get("/")
    assert res.status_code == 200
    html = res.get_data(as_text=True)
    assert 'id="config"' in html and "daily-2026-11-06" in html
    assert "game.js" in html


def test_config_endpoint(client):
    """Same config is available as JSON."""
    data = client.get("/api/config").get_json()
    assert data["daily"] == "daily-2026-11-06"
    assert "drifter" in data["enemies"] and "rapid" in data["upgrades"]
    assert data["xp_table"][0] == 5
    assert data["repair_every"] == 5 and data["repair_amount"] == 2
    assert data["upgrades"]["hull"]["max"] is None
    assert data["blade_hp"] == 5


def test_daily_run_uses_the_shared_seed(client):
    """Daily runs all start from the same seed and first wave."""
    first = client.post("/api/run", json={"daily": True}).get_json()
    second = client.post("/api/run", json={"daily": True}).get_json()
    assert first["seed"] == "daily-2026-11-06"
    assert first == second
    assert first["first"]["wave"] == 1


def test_normal_runs_get_fresh_seeds(client):
    """Normal runs are random, and a missing body is fine."""
    one = client.post("/api/run").get_json()
    two = client.post("/api/run", json={}).get_json()
    assert one["daily"] is False
    assert one["seed"].startswith("run-") and one["seed"] != two["seed"]


def test_wave_endpoint_matches_the_director(client):
    """The API returns exactly what waves.plan returns."""
    data = client.get("/api/wave?seed=abc&n=12").get_json()
    assert data == web.waves.plan("abc", 12)


@pytest.mark.parametrize(
    "query", ["seed=abc", "n=3", "seed=a%20b&n=3", "seed=abc&n=0", "seed=abc&n=x"]
)
def test_wave_endpoint_rejects_bad_input(client, query):
    """Bad seeds or wave numbers get a 400 with a message, not a crash."""
    res = client.get(f"/api/wave?{query}")
    assert res.status_code == 400
    assert res.get_json()["error"]


def test_pwa_files(client):
    """Manifest and service worker are served from the root."""
    assert client.get("/manifest.webmanifest").mimetype == "application/manifest+json"
    res = client.get("/sw.js")
    assert res.status_code == 200 and res.headers["Cache-Control"] == "no-cache"
