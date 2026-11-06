"""Unit checks for the upgrade list."""

import pytest

import upgrades

pytestmark = pytest.mark.unit


def test_every_upgrade_has_display_fields_and_a_cap():
    """The level-up cards need a name, icon, text and a max stack."""
    for info in upgrades.UPGRADES.values():
        assert info["name"] and info["icon"] and info["text"]
        assert info["max"] >= 1


def test_maxed_upgrades_are_no_longer_offered():
    """Once an upgrade hits its cap it leaves the pool."""
    owned = {"spread": upgrades.UPGRADES["spread"]["max"]}
    assert "spread" not in upgrades.available(owned)
    assert not upgrades.can_pick("spread", owned)
    assert upgrades.can_pick("rapid", owned)


def test_everything_maxed_leaves_nothing():
    """The client shows Field Repair when this list is empty."""
    owned = {key: info["max"] for key, info in upgrades.UPGRADES.items()}
    assert not upgrades.available(owned)


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
