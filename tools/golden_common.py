"""Shared by the golden scripts: the prototype at its last commit (see
prototype.py) plus the frozen snapshot of your data (tools/snapshot.py)."""
import pathlib

from prototype import CHESS, COMMIT, PROTOTYPE  # noqa: F401

SNAPSHOT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "chessprep.snapshot.db"
assert SNAPSHOT.exists(), "run tools/snapshot.py first"
