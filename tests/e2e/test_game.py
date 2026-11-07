"""Real Chromium journeys: start, level up, pause, die, save a score."""

import re

import pytest
from playwright.sync_api import Page, expect

pytestmark = pytest.mark.e2e


def snapshot(page: Page):
    """The game's own read-only state hook."""
    return page.evaluate("window.__neon.snapshot()")


def start(page: Page, live_server, button="#play-btn"):
    """Open the menu and start a run."""
    page.goto(live_server)
    expect(page.locator("#title")).to_be_visible()
    page.click(button)
    expect(page.locator("#hud")).to_be_visible()
    expect(page.locator("#wave-label")).to_have_text("WAVE 1")


def test_menu_lists_the_swarm(page: Page, live_server):
    """The codex is built from the server's enemy list (shards excluded)."""
    page.goto(live_server)
    expect(page.locator("#codex li")).to_have_count(6)
    expect(page.locator("#codex li").first).to_contain_text("Drifter")


def test_run_spawns_enemies_and_the_ship_fights(page: Page, live_server):
    """Wave 1 spawns, auto-aim fires, and something dies."""
    start(page, live_server)
    page.evaluate("window.__neon.setShields(99)")
    page.wait_for_function("window.__neon.snapshot().kills > 0", timeout=15000)
    state = snapshot(page)
    assert state["mode"] == "play" and state["score"] > 0
    assert re.match(r"run-[0-9a-f]+", state["seed"])


def test_level_up_offers_three_cards_and_applies_one(page: Page, live_server):
    """Enough XP pauses the game on three upgrade cards; a key picks one."""
    start(page, live_server)
    page.evaluate("window.__neon.giveXp(5)")
    expect(page.locator("#levelup")).to_be_visible()
    expect(page.locator("#cards .card")).to_have_count(3)
    page.keyboard.press("2")
    expect(page.locator("#levelup")).to_be_hidden()
    state = snapshot(page)
    assert state["level"] == 2 and sum(state["upgrades"].values()) == 1


def test_pause_and_resume(page: Page, live_server):
    """P pauses (sim frozen) and resumes."""
    start(page, live_server)
    page.keyboard.press("p")
    expect(page.locator("#pause")).to_be_visible()
    assert snapshot(page)["mode"] == "pause"
    page.click("#resume-btn")
    expect(page.locator("#pause")).to_be_hidden()


def test_dying_offers_initials_and_saves_to_the_board(page: Page, live_server):
    """Out of shields, one more hit ends the run; a top score gets saved."""
    start(page, live_server, "#daily-btn")
    page.wait_for_function("window.__neon.snapshot().score > 0", timeout=15000)
    if page.locator("#levelup").is_visible():
        page.keyboard.press("1")
    page.evaluate("window.__neon.setShields(0)")
    page.evaluate("window.__neon.hurt()")
    expect(page.locator("#over")).to_be_visible(timeout=5000)
    page.fill("#initials", "tjm")
    page.click("#initials-form button")
    page.click("#menu-btn")
    page.click("[data-board=daily]")
    expect(page.locator("#board li").first).to_contain_text("TJM")


def test_magnet_collects_every_shard_while_moving(page: Page, live_server):
    """Shards that enter the magnet always reach the ship, even mid-dash.

    Kills elsewhere can drop new shards outside the magnet during the test, so
    the check is that no *locked-on* shard is still in flight.
    """
    start(page, live_server)
    page.evaluate("window.__neon.setShields(99)")
    page.evaluate("window.__neon.dropXpAround(40, 80)")
    page.keyboard.down("d")
    page.keyboard.press("Space")
    page.wait_for_timeout(300)
    page.keyboard.up("d")
    page.keyboard.down("s")
    page.keyboard.press("Space")
    page.keyboard.up("s")
    # 40 XP is several level-ups; each one pauses the game until a card is picked.
    for _ in range(60):
        if page.locator("#levelup").is_visible():
            page.keyboard.press("1")
        elif not snapshot(page)["lockedGems"]:
            break
        page.wait_for_timeout(100)
    state = snapshot(page)
    assert state["lockedGems"] == 0, state["gemInfo"]
    assert state["level"] >= 4


def test_blades_shoot_at_half_the_ship_fire_rate(page: Page, live_server):
    """Two blades together fire about as many bullets as the ship (2 x half)."""
    start(page, live_server)
    page.evaluate("window.__neon.setShields(99)")
    page.evaluate("window.__neon.grant('orbit', 2)")
    for _ in range(250):
        if page.locator("#levelup").is_visible():
            page.keyboard.press("1")
        state = snapshot(page)
        if state["bladeShots"] >= 20 and state["shipShots"] >= 20:
            break
        page.wait_for_timeout(100)
    # Level-ups above may have added Split Beam (+1 blade bullet per 2 picks).
    per_volley = 1 + state["upgrades"].get("spread", 0) // 2
    ship_volley = 1 + state["upgrades"].get("spread", 0)
    ratio = (state["bladeShots"] / per_volley) / max(
        1, state["shipShots"] / ship_volley
    )
    assert 0.5 < ratio < 1.5, state


def test_every_fifth_level_repairs_two_shields(page: Page, live_server):
    """Reaching level 5 shows the bonus and repairs 2 shields."""
    start(page, live_server)
    page.evaluate("window.__neon.setShields(1)")
    page.evaluate(
        "window.__neon.giveXp(window.__neon_xp = JSON.parse("
        "document.getElementById('config').textContent).xp_table"
        ".slice(0, 4).reduce((a, b) => a + b))"
    )
    for _ in range(3):
        expect(page.locator("#levelup")).to_be_visible()
        expect(page.locator("#levelup-bonus")).to_be_hidden()
        # Skip Reinforced Hull: it repairs a shield too, which would blur the check.
        cards = page.locator("#cards .card").all_inner_texts()
        pick = next(i for i, text in enumerate(cards) if "Hull" not in text)
        page.keyboard.press(str(pick + 1))
    expect(page.locator("#levelup-num")).to_have_text("5")
    expect(page.locator("#levelup-bonus")).to_contain_text("+2 shields repaired")
    assert snapshot(page)["shields"] == 3


def test_hull_is_endless_and_hud_stays_compact(page: Page, live_server):
    """Hull keeps stacking past the old cap; big shield counts show as a number."""
    start(page, live_server)
    page.evaluate("window.__neon.grant('hull', 9)")
    assert snapshot(page)["maxShields"] == 12
    expect(page.locator("#shields span")).to_have_text(re.compile(r"\d+/12"))


def test_blade_breaks_after_five_enemy_hits(page: Page, live_server):
    """Enemy shots chip a blade; the fifth hit destroys it and it can be re-bought."""
    start(page, live_server)
    page.evaluate("window.__neon.setShields(99)")
    page.evaluate("window.__neon.grant('orbit', 2)")
    for hit in range(1, 5):
        page.evaluate("window.__neon.shootBlade(0)")
        page.wait_for_function(
            f"window.__neon.snapshot().bladeHp.includes({5 - hit})", timeout=3000
        )
        if page.locator("#levelup").is_visible():
            page.keyboard.press("1")
    page.evaluate("window.__neon.shootBlade(0)")
    page.wait_for_function(
        "window.__neon.snapshot().bladeHp.length === 1", timeout=3000
    )
    state = snapshot(page)
    assert state["upgrades"]["orbit"] == 1
    page.evaluate("window.__neon.grant('orbit', 1)")
    assert snapshot(page)["bladeHp"] == [5, 5] or len(snapshot(page)["bladeHp"]) == 2


def test_music_follows_the_fight(page: Page, live_server):
    """Calm on the menu, synthwave in waves, the boss track for the Hive, and back."""
    page.goto(live_server)
    page.locator("#title").click()  # first gesture unlocks audio
    page.wait_for_function(
        "window.__neon.snapshot().music.track === 'calm'", timeout=5000
    )
    page.click("#play-btn")
    page.wait_for_function(
        "window.__neon.snapshot().music.track === 'play'", timeout=5000
    )
    page.evaluate("window.__neon.setShields(99)")
    page.evaluate("window.__neon.jumpTo(10)")
    page.wait_for_function(
        "window.__neon.snapshot().music.track === 'boss'", timeout=5000
    )
    page.evaluate("window.__neon.jumpTo(11)")
    page.wait_for_function(
        "window.__neon.snapshot().music.track === 'play'", timeout=5000
    )
    state = snapshot(page)["music"]
    assert state["notes"] > 0 or not state["running"]
    page.keyboard.press("n")
    assert (
        page.evaluate("JSON.parse(localStorage.getItem('neon-swarm:music'))") is False
    )


def test_damaged_blades_repair_every_second_wave(page: Page, live_server):
    """A chipped blade regains one hit after each even wave, up to full."""
    start(page, live_server)
    page.evaluate("window.__neon.setShields(99)")
    page.evaluate("window.__neon.grant('orbit', 2)")
    for hit in (1, 2):
        page.evaluate("window.__neon.shootBlade(0)")
        page.wait_for_function(
            f"window.__neon.snapshot().bladeHp.includes({5 - hit})", timeout=3000
        )
    page.evaluate("window.__neon.clearWave()")  # wave 1: odd, no repair
    page.wait_for_function("window.__neon.snapshot().wave === 2", timeout=10000)
    assert sorted(snapshot(page)["bladeHp"]) == [3, 5]
    page.evaluate("window.__neon.clearWave()")  # wave 2: repair
    page.wait_for_function("window.__neon.snapshot().bladeHp.includes(4)", timeout=5000)
    assert sorted(snapshot(page)["bladeHp"]) == [4, 5]


def test_tough_enemies_drop_a_shard_per_xp(page: Page, live_server):
    """A Bulwark-sized payout scatters as single shards; the Hive bundles some."""
    start(page, live_server)
    before = snapshot(page)["gems"]
    page.evaluate("window.__neon.dropXp(10)")
    assert snapshot(page)["gems"] - before == 10
    page.evaluate("window.__neon.dropXp(40)")
    assert snapshot(page)["gems"] - before == 10 + 16
