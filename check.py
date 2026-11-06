"""Run the same formatting, static analysis, and tests locally and in CI."""

import argparse
from pathlib import Path
import subprocess
import sys

PROJECT = Path(__file__).resolve().parent


def main() -> int:
    """Run every check and return failure if any tool reports a problem."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fast",
        action="store_true",
        help="skip the real-browser checks; this is not the full pre-PR check",
    )
    options = parser.parse_args()
    # Check project code and tests without traversing .venv or downloaded code.
    files = sorted(PROJECT.glob("*.py")) + sorted((PROJECT / "tests").rglob("*.py"))
    paths = [str(path.relative_to(PROJECT)) for path in files]
    checks = [
        ("Black: formatting", ["black", "--check", "--diff", *paths]),
        ("Pylint: code analysis", ["pylint", *paths]),
        ("pytest: non-browser checks", ["pytest", "-q", "-m", "not e2e"]),
    ]
    if not options.fast:
        checks.append(
            (
                "pytest: real Chromium browser",
                [
                    "pytest",
                    "-q",
                    "-m",
                    "e2e",
                    "--tracing=retain-on-failure",
                    "--screenshot=only-on-failure",
                ],
            )
        )
    failures = []
    for label, arguments in checks:
        print(f"\n--- {label} ---", flush=True)
        result = subprocess.run(  # no shell: paths and arguments stay literal
            [sys.executable, "-m", *arguments], cwd=PROJECT, check=False
        )
        if result.returncode:
            failures.append(label)
        print(f"{'FAIL' if result.returncode else 'PASS'}: {label}", flush=True)

    if options.fast:
        print("\nSKIPPED: real-browser checks (--fast). Full check still required.")
    if failures:
        print("\nChecks failed: " + "; ".join(failures), flush=True)
        return 1
    if options.fast:
        print("\nFast checks passed; browser behavior has not been checked.")
    else:
        print("\nAll configured checks passed.")
    print("Play the game yourself too: automated checks are not the whole story.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
