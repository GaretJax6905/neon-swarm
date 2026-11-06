"""Wave director: turns a seed and a wave number into a spawn plan.

The same seed and wave always give the same plan, so a Daily Run is the same
swarm for everyone who plays it that day. The browser only draws and simulates;
what shows up, when, and how tough it is gets decided here.
"""

import random
import re

# Every enemy the browser knows how to draw. "cost" is how much of a wave's
# budget one of them uses; cost 0 means it is never spawned directly.
ENEMIES = {
    "drifter": {
        "name": "Drifter",
        "cost": 1,
        "from_wave": 1,
        "hp": 1,
        "speed": 95,
        "radius": 13,
        "color": "#33f0ff",
        "score": 10,
        "xp": 1,
        "about": "Floats straight at you.",
    },
    "dart": {
        "name": "Dart",
        "cost": 2,
        "from_wave": 3,
        "hp": 1,
        "speed": 330,
        "radius": 11,
        "color": "#ffe14d",
        "score": 20,
        "xp": 1,
        "about": "Aims, pauses, then charges in a straight line.",
    },
    "splitter": {
        "name": "Splitter",
        "cost": 3,
        "from_wave": 5,
        "hp": 3,
        "speed": 70,
        "radius": 18,
        "color": "#ff4fd8",
        "score": 30,
        "xp": 2,
        "about": "Bursts into three shards when destroyed.",
    },
    "shard": {
        "name": "Shard",
        "cost": 0,
        "from_wave": 5,
        "hp": 1,
        "speed": 150,
        "radius": 8,
        "color": "#ff9cf0",
        "score": 5,
        "xp": 0,
        "about": "Fast leftovers from a Splitter.",
    },
    "orbiter": {
        "name": "Orbiter",
        "cost": 4,
        "from_wave": 7,
        "hp": 4,
        "speed": 120,
        "radius": 15,
        "color": "#9d6bff",
        "score": 40,
        "xp": 3,
        "about": "Circles at range and fires slow plasma.",
    },
    "tank": {
        "name": "Bulwark",
        "cost": 6,
        "from_wave": 9,
        "hp": 14,
        "speed": 45,
        "radius": 26,
        "color": "#ff7a2f",
        "score": 80,
        "xp": 6,
        "about": "Slow, armored, and shoves you back.",
    },
    "hive": {
        "name": "The Hive",
        "cost": 0,
        "from_wave": 10,
        "hp": 140,
        "speed": 40,
        "radius": 52,
        "color": "#7cff6b",
        "score": 1000,
        "xp": 30,
        "about": "Boss every 10 waves: bullet rings and Drifter swarms.",
    },
}

PATTERNS = ("edge", "ring", "corner", "line")
BOSS_EVERY = 10
MAX_WAVE = 999
_SEED_SHAPE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class WaveError(ValueError):
    """A request for a wave that cannot exist."""


def check_seed(seed):
    """Return the seed if it is a short, plain token; raise otherwise."""
    if not isinstance(seed, str) or not _SEED_SHAPE.match(seed):
        raise WaveError("Seed must be 1-64 letters, digits, '-' or '_'.")
    return seed


def check_wave(number):
    """Return the wave number as an int in 1..MAX_WAVE; raise otherwise."""
    try:
        wave = int(number)
    except (TypeError, ValueError) as problem:
        raise WaveError("Wave must be a whole number.") from problem
    if not 1 <= wave <= MAX_WAVE:
        raise WaveError(f"Wave must be between 1 and {MAX_WAVE}.")
    return wave


def is_boss_wave(wave):
    """Every tenth wave is a boss fight."""
    return wave % BOSS_EVERY == 0


def budget(wave):
    """How many cost points of enemies a normal wave spends."""
    return 10 + 4 * wave + wave * wave // 10


def hp_scale(wave):
    """Enemies get 8% tougher every wave."""
    return round(1 + 0.08 * (wave - 1), 2)


def speed_scale(wave):
    """Enemies speed up 2% per wave, capped at 60% faster."""
    return round(min(1.6, 1 + 0.02 * (wave - 1)), 2)


def unlocked(wave):
    """Kinds a normal wave may spawn, cheapest first."""
    kinds = [
        key
        for key, info in ENEMIES.items()
        if info["cost"] > 0 and info["from_wave"] <= wave
    ]
    return sorted(kinds, key=lambda key: ENEMIES[key]["cost"])


def _groups(rng, wave, points):
    """Spend the budget on groups of one kind each, spaced out in time."""
    kinds = unlocked(wave)
    groups = []
    at = 0.0
    while points > 0:
        affordable = [k for k in kinds if ENEMIES[k]["cost"] <= points]
        # Cheap kinds keep the swarm dense; newer kinds still show up often.
        weights = [
            (2 + index) / ENEMIES[k]["cost"] for index, k in enumerate(affordable)
        ]
        kind = rng.choices(affordable, weights=weights)[0]
        cost = ENEMIES[kind]["cost"]
        count = min(rng.randint(4, 9), points // cost)
        points -= count * cost
        groups.append(
            {
                "kind": kind,
                "count": count,
                "pattern": rng.choice(PATTERNS),
                "at": round(at, 2),
            }
        )
        at += rng.uniform(1.2, 2.6)
    return groups


def plan(seed, wave):
    """Return the full spawn plan for one wave of one seed."""
    seed = check_seed(seed)
    wave = check_wave(wave)
    rng = random.Random(f"{seed}:{wave}")
    boss = is_boss_wave(wave)
    if boss:
        lap = wave // BOSS_EVERY
        groups = [{"kind": "hive", "count": lap, "pattern": "ring", "at": 0.0}]
        escort = _groups(rng, wave, budget(wave) // 4)
        groups += [{**group, "at": round(group["at"] + 4, 2)} for group in escort]
    else:
        groups = _groups(rng, wave, budget(wave))
    return {
        "seed": seed,
        "wave": wave,
        "boss": boss,
        "hp_scale": hp_scale(wave),
        "speed_scale": speed_scale(wave),
        "groups": groups,
        "total": sum(group["count"] for group in groups),
    }
