"""Unit checks for the wave director."""

import pytest

import waves

pytestmark = pytest.mark.unit


def test_same_seed_and_wave_give_the_same_plan():
    """A Daily Run must be identical for everyone who plays it."""
    assert waves.plan("daily-2026-11-06", 7) == waves.plan("daily-2026-11-06", 7)


def test_different_seeds_give_different_plans():
    """Fresh runs should not all look alike."""
    plans = {str(waves.plan(f"run-{n}", 6)["groups"]) for n in range(20)}
    assert len(plans) > 10


def test_wave_spends_its_whole_budget():
    """Every point of the budget turns into enemies (no rounding leftovers)."""
    for wave in (1, 4, 9, 23, 57):
        plan = waves.plan("budget", wave)
        spent = sum(
            g["count"] * waves.ENEMIES[g["kind"]]["cost"] for g in plan["groups"]
        )
        assert spent == waves.budget(wave)


def test_only_unlocked_enemies_appear():
    """Wave 1 is Drifters only; nothing shows up before its from_wave."""
    assert {g["kind"] for g in waves.plan("x", 1)["groups"]} == {"drifter"}
    for wave in range(1, 40):
        if waves.is_boss_wave(wave):
            continue
        for group in waves.plan("x", wave)["groups"]:
            assert waves.ENEMIES[group["kind"]]["from_wave"] <= wave


def test_boss_every_tenth_wave_with_more_hives_each_lap():
    """Wave 10 has one Hive, wave 20 two, and normal waves none."""
    assert waves.plan("b", 10)["boss"] is True
    hives = [g for g in waves.plan("b", 20)["groups"] if g["kind"] == "hive"]
    assert hives[0]["count"] == 2
    assert not any(g["kind"] == "hive" for g in waves.plan("b", 11)["groups"])


def test_groups_are_spaced_out_in_time():
    """Spawn times only go forward, so the client can play them in order."""
    times = [g["at"] for g in waves.plan("time", 15)["groups"]]
    assert times == sorted(times)
    assert times[0] == 0


def test_difficulty_scales_and_speed_caps():
    """HP keeps growing; speed stops at +60%."""
    assert waves.hp_scale(1) == 1
    assert waves.hp_scale(11) == pytest.approx(1.8)
    assert waves.speed_scale(1) == 1
    assert waves.speed_scale(500) == 1.6


@pytest.mark.parametrize("seed", ["", "a" * 65, "has space", "../etc", None, 5])
def test_bad_seeds_are_rejected(seed):
    """Seeds are short plain tokens only."""
    with pytest.raises(waves.WaveError):
        waves.plan(seed, 1)


@pytest.mark.parametrize("wave", [0, -1, 1000, "two", None, "1.5"])
def test_bad_wave_numbers_are_rejected(wave):
    """Waves are whole numbers from 1 to MAX_WAVE."""
    with pytest.raises(waves.WaveError):
        waves.plan("ok", wave)


def test_tougher_enemies_drop_more_xp():
    """XP climbs with toughness, so harder kills drop more shards."""
    xp = {key: info["xp"] for key, info in waves.ENEMIES.items()}
    assert xp["drifter"] == xp["dart"] == 1
    assert xp["drifter"] < xp["splitter"] < xp["orbiter"] < xp["tank"] < xp["hive"]
    assert xp["shard"] == 0
