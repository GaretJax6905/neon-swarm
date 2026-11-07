"""Level-up upgrades: what each one does and how many times it can stack.

The browser applies the effects; this module is the single list of what exists,
so the menu, the level-up cards, and the tests all agree. "max": None means the
upgrade is endless: it can be picked again on every level-up.
"""

UPGRADES = {
    "rapid": {
        "name": "Overclock",
        "icon": "⚡",
        "text": "Fire 18% faster (+6% per pick after the 6th).",
        "max": None,
    },
    "spread": {
        "name": "Split Beam",
        "icon": "🔱",
        "text": "+1 bullet per shot, fanned out.",
        "max": 4,
    },
    "pierce": {
        "name": "Phase Rounds",
        "icon": "🪡",
        "text": "Bullets pass through 1 more enemy.",
        "max": 3,
    },
    "power": {
        "name": "Hot Plasma",
        "icon": "🔥",
        "text": "+1 damage per bullet and blade.",
        "max": None,
    },
    "speed": {
        "name": "Thrusters",
        "icon": "🚀",
        "text": "Move 12% faster.",
        "max": 4,
    },
    "magnet": {
        "name": "Tractor Field",
        "icon": "🧲",
        "text": "Pull XP shards from farther away.",
        "max": None,
    },
    "hull": {
        "name": "Reinforced Hull",
        "icon": "🛡️",
        "text": "+1 max shield and repair 1.",
        "max": None,
    },
    "dash": {
        "name": "Blink Drive",
        "icon": "💨",
        "text": "Dash recharges 25% faster.",
        "max": 3,
    },
    "orbit": {
        "name": "Orbit Blades",
        "icon": "🌀",
        "text": "+1 blade. Blades shoot at half your fire rate and block enemy shots, "
        "but break after 5 hits. Damaged blades repair 1 hit every 2 waves.",
        "max": None,
    },
    "nova": {
        "name": "Nova Core",
        "icon": "💥",
        "text": "Dashing releases a damaging shockwave (+size each pick).",
        "max": 3,
    },
}

OFFER_SIZE = 3
REPAIR_EVERY = 5
REPAIR_AMOUNT = 2
BLADE_HP = 5  # enemy-bullet hits an orbit blade survives
BLADE_REPAIR_EVERY = 2  # damaged blades repair 1 hit every this many cleared waves


def is_endless(key):
    """True if this upgrade never maxes out."""
    return UPGRADES[key]["max"] is None


def available(owned):
    """Upgrade ids that can still be picked, given {id: times_picked}."""
    owned = owned or {}
    return [
        key
        for key, info in UPGRADES.items()
        if info["max"] is None or owned.get(key, 0) < info["max"]
    ]


def can_pick(key, owned):
    """True if this upgrade exists and is not maxed out."""
    return key in available(owned)


def repairs_at(level):
    """Shields repaired on reaching this level (every 5th level repairs 2)."""
    return REPAIR_AMOUNT if level > 1 and level % REPAIR_EVERY == 0 else 0


def xp_to_next(level):
    """XP needed to go from this level to the next (grows gently)."""
    if level < 1:
        raise ValueError("Levels start at 1.")
    return 5 + 4 * (level - 1) + (level - 1) ** 2 // 3
