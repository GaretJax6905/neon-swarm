"""Unit checks for the upgrade list."""

import pytest

import upgrades

pytestmark = pytest.mark.unit


def test_every_upgrade_has_display_fields_and_a_cap():
    """The level-up cards need a name, icon, text, and a max stack or None."""
    for info in upgrades.UPGRADES.values():
        assert info["name"] and info["icon"] and info["text"]
        assert info["max"] is None or info["max"] >= 1


def test_hull_and_core_stats_are_endless():
    """Hull, damage, fire rate, magnet and blades can be picked forever."""
    for key in ("hull", "power", "rapid", "magnet", "orbit"):
        assert upgrades.is_endless(key)
        assert upgrades.can_pick(key, {key: 500})
    assert not upgrades.is_endless("spread")


def test_maxed_upgrades_are_no_longer_offered():
    """Once an upgrade hits its cap it leaves the pool."""
    owned = {"spread": upgrades.UPGRADES["spread"]["max"]}
    assert "spread" not in upgrades.available(owned)
    assert not upgrades.can_pick("spread", owned)
    assert upgrades.can_pick("rapid", owned)


def test_with_everything_capped_only_endless_upgrades_remain():
    """Level-ups never run out of choices once the capped upgrades are maxed."""
    owned = {key: info["max"] or 99 for key, info in upgrades.UPGRADES.items()}
    left = upgrades.available(owned)
    assert sorted(left) == sorted(
        k for k in upgrades.UPGRADES if upgrades.is_endless(k)
    )
    assert len(left) >= upgrades.OFFER_SIZE


def test_every_fifth_level_repairs_two_shields():
    """Levels 5, 10, 15 ... repair 2 shields; other levels repair none."""
    assert [upgrades.repairs_at(level) for level in (5, 10, 15, 50)] == [2, 2, 2, 2]
    assert [upgrades.repairs_at(level) for level in (1, 2, 4, 6, 9, 11)] == [0] * 6


def test_unknown_upgrade_cannot_be_picked():
    """Only real upgrade ids count."""
    assert not upgrades.can_pick("god-mode", {})


def test_xp_curve_grows():
    """Each level costs at least as much as the last."""
    costs = [upgrades.xp_to_next(level) for level in range(1, 50)]
    assert costs[0] == 5
    assert all(b >= a for a, b in zip(costs, costs[1:]))
    with pytest.raises(ValueError):
        upgrades.xp_to_next(0)
