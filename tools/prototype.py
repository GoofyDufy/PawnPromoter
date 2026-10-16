"""Puts the prototype's code as of its last COMMIT on sys.path — never your
uncommitted edits (only committed changes are ported). Used by every tool.

The commit is extracted with `git archive` into tests/golden/prototype/
(gitignored); this only reads ~/Chess, it writes nothing there.
PROTOTYPE_REF=<commit> picks another commit.
"""
import io, os, pathlib, shutil, subprocess, sys, tarfile

CHESS = pathlib.Path(os.environ.get("CHESS_DIR", pathlib.Path.home() / "Chess"))
PROTOTYPE = pathlib.Path(__file__).resolve().parent.parent / "tests" / "golden" / "prototype"
REF = os.environ.get("PROTOTYPE_REF", "HEAD")

COMMIT = subprocess.run(["git", "-C", str(CHESS), "rev-parse", "--short", REF],
                        capture_output=True, text=True, check=True).stdout.strip()
_stamp = PROTOTYPE / ".commit"
if not (_stamp.exists() and _stamp.read_text() == COMMIT):
    shutil.rmtree(PROTOTYPE, ignore_errors=True)
    PROTOTYPE.mkdir(parents=True)
    _tar = subprocess.run(["git", "-C", str(CHESS), "archive", "--format=tar", COMMIT],
                          capture_output=True, check=True).stdout
    tarfile.open(fileobj=io.BytesIO(_tar)).extractall(PROTOTYPE, filter="data")
    _stamp.write_text(COMMIT)
sys.path.insert(0, str(PROTOTYPE))
