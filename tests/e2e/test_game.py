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
