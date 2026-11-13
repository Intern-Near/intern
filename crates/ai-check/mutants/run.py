#!/usr/bin/env python3
"""Mutation run for ai-check: do the tests notice when check 3, 4 or 5 is broken?

Each mutant in mutants.toml is one small, hand-written mistake in crates/ai-check/src. For each one this script
writes it into the source file, runs `cargo test -p ai-check --locked -q`, records whether the tests catch it (a test
fails, or the mutant does not build) or not (it survives), and puts the original file back byte for byte: also on an
error, Ctrl-C or a kill (SIGTERM, SIGHUP). While a mutant is in place a copy of the original sits in the target
directory, so even a run killed with SIGKILL is put right by the next run.

    export CARGO_TARGET_DIR=<the shared target directory>   # optional, passed on to cargo
    python3 crates/ai-check/mutants/run.py                  # every mutant
    python3 crates/ai-check/mutants/run.py S4 R8 L6         # only these

Standard library only; Python 3.11 or later (tomllib). Exit code 0 when every mutant is caught (and every mutant
marked equivalent survives), 1 when not, 2 when the run could not be made.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import os
import re
import signal
import subprocess
import sys
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import NoReturn

HERE = Path(__file__).resolve().parent  # crates/ai-check/mutants
CRATE = HERE.parent  # crates/ai-check
ROOT = CRATE.parent.parent  # the workspace
COMMAND = ["cargo", "test", "-p", "ai-check", "--locked", "-q"]
HELD = {signal.SIGINT, signal.SIGTERM, signal.SIGHUP}
FIELDS = {"id", "check", "file", "what", "find", "replace", "equivalent"}


@dataclass(frozen=True)
class Mutant:
    id: str
    check: int
    file: str  # relative to crates/ai-check
    what: str
    find: bytes
    replace: bytes
    equivalent: str  # why it behaves like the original; "" for an ordinary mutant

    def apply(self, original: bytes) -> bytes:
        return original.replace(self.find, self.replace, 1)


@dataclass
class Outcome:
    kind: str  # "test" or "build" (caught), "crash" (caught), "survived", "timeout", "error"
    detail: str
    seconds: float
    tests: list[str] = field(default_factory=list)

    @property
    def caught(self) -> bool:
        return self.kind in ("test", "build", "crash")

    def text(self) -> str:
        if self.kind == "test":
            more = f" (+{len(self.tests) - 1} more)" if len(self.tests) > 1 else ""
            return f"caught: test failed: {self.tests[0]}{more}"
        if self.kind == "build":
            return f"caught: build failed: {self.detail}"
        if self.kind == "crash":
            return f"caught: {self.detail}"
        return f"{self.kind.upper()}: {self.detail}"


def fail(message: str) -> NoReturn:
    print(f"run.py: {message}", file=sys.stderr)
    sys.exit(2)


def load(path: Path) -> list[Mutant]:
    with path.open("rb") as f:
        entries = tomllib.load(f).get("mutant", [])
    mutants: list[Mutant] = []
    for n, e in enumerate(entries, 1):
        if missing := {"id", "check", "file", "what", "find", "replace"} - e.keys():
            fail(f"{path.name}: mutant {n} has no {', '.join(sorted(missing))}")
        if unknown := e.keys() - FIELDS:
            fail(f"{path.name}: mutant {e['id']} has unknown fields {', '.join(sorted(unknown))}")
        m = Mutant(e["id"], e["check"], e["file"], e["what"], e["find"].encode(), e["replace"].encode(),
                   e.get("equivalent", ""))
        if any(m.id == other.id for other in mutants):
            fail(f"{path.name}: {m.id} appears twice")
        if m.check not in (3, 4, 5) or not m.find or m.find == m.replace or not m.file.startswith("src/"):
            fail(f"{path.name}: {m.id} needs check 3, 4 or 5, a file under src/, and a find text that changes")
        mutants.append(m)
    return mutants


def copies_dir() -> Path:
    """Where the originals wait while a mutant is in place: the target directory, never the source tree."""
    target = Path(os.environ.get("CARGO_TARGET_DIR") or "target")
    target = target if target.is_absolute() else ROOT / target
    return target / "ai-check-mutants" / hashlib.sha256(str(CRATE).encode()).hexdigest()[:12]


def copy_of(copies: Path, file: str) -> Path:
    return copies / file.replace("/", "__")


def put_back_leftovers(mutants: list[Mutant], copies: Path) -> None:
    """A copy left behind means a run was killed with a mutant in place: put the original back first."""
    for copy in sorted(copies.glob("*")):
        file = copy.name.replace("__", "/")
        path = CRATE / file
        saved, current = copy.read_bytes(), path.read_bytes()
        if current != saved and not any(m.file == file and m.apply(saved) == current for m in mutants):
            fail(f"{path} differs from the copy an interrupted run left at {copy}, and not by one mutant. "
                 "Check it by hand (git diff), then delete the copy.")
        if current != saved:
            path.write_bytes(saved)
            print(f"note: put back {file}, left mutated by an interrupted run")
        copy.unlink()


@contextlib.contextmanager
def signals_held():
    """A Ctrl-C or kill that arrives while the original is being written back waits until it is written."""
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, HELD)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def kill(proc: subprocess.Popen) -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(proc.pid, signal.SIGKILL)  # cargo, rustc and the test binary: the whole process group
    proc.wait()


def run_tests(timeout: float) -> Outcome:
    start = time.monotonic()
    proc = subprocess.Popen(COMMAND, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill(proc)
        return Outcome("timeout", f"no result after {timeout:.0f} s", time.monotonic() - start)
    except BaseException:
        kill(proc)
        raise
    return classify(proc.returncode, out.decode("utf-8", "replace"), time.monotonic() - start)


def classify(code: int, out: str, seconds: float) -> Outcome:
    if code == 0:
        return Outcome("survived", "every test passed", seconds)
    if "could not compile" in out:
        first = next((line for line in out.splitlines() if line.startswith("error")), "error")
        return Outcome("build", first, seconds)
    # libtest ends with "failures:" and one indented line per failed test.
    parts = out.rsplit("\nfailures:\n", 1)
    failed = re.findall(r"^    (\S+)$", parts[1], re.M) if len(parts) == 2 else []
    if failed:
        return Outcome("test", "", seconds, [t.removeprefix("tests::") for t in failed])
    if died := re.search(r"signal: \d+, (SIG[A-Z]+)", out):
        return Outcome("crash", f"the test binary died ({died.group(1)})", seconds)
    last = out.strip().splitlines()[-1] if out.strip() else f"exit code {code}"
    return Outcome("error", last, seconds)


def run_one(m: Mutant, originals: dict[str, bytes], copies: Path, timeout: float) -> Outcome:
    path, original = CRATE / m.file, originals[m.file]
    copy = copy_of(copies, m.file)
    copy.write_bytes(original)
    try:
        path.write_bytes(m.apply(original))
        return run_tests(timeout)
    finally:
        with signals_held():
            path.write_bytes(original)
            if path.read_bytes() != original:
                fail(f"{path} could not be put back; the original is at {copy}")
            copy.unlink()


def where(m: Mutant, originals: dict[str, bytes]) -> str:
    text = originals[m.file]
    line = text[: text.index(m.find)].count(b"\n") + 1
    return f"{Path(m.file).name}:{line}"


def interrupted(signum: int, _frame: object) -> NoReturn:
    raise KeyboardInterrupt(signal.Signals(signum).name)


def print_table(rows: list[tuple[Mutant, Outcome]], originals: dict[str, bytes]) -> None:
    head = ("id", "check", "where", "mutation", "result", "secs")
    lines = [(m.id, str(m.check), where(m, originals), m.what,
              f"equivalent, {o.text()}" if m.equivalent else o.text(), f"{o.seconds:.0f}") for m, o in rows]
    widths = [max(len(r[i]) for r in [head, *lines]) for i in range(len(head))]
    for r in [head, tuple("-" * w for w in widths), *lines]:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("ids", nargs="*", help="run only these mutants (default: all)")
    parser.add_argument("--timeout", type=float, default=900, help="seconds per test run (default 900)")
    args = parser.parse_args()

    for s in (signal.SIGTERM, signal.SIGHUP):  # Ctrl-C already raises KeyboardInterrupt
        signal.signal(s, interrupted)
    # Ask for no core file if a mutant crashes the test binary (none of the current ones do).
    with contextlib.suppress(ImportError, ValueError, OSError):
        import resource

        resource.setrlimit(resource.RLIMIT_CORE, (0, resource.getrlimit(resource.RLIMIT_CORE)[1]))

    mutants = load(HERE / "mutants.toml")
    if unknown := set(args.ids) - {m.id for m in mutants}:
        fail(f"no mutant {', '.join(sorted(unknown))} in mutants.toml")
    chosen = [m for m in mutants if not args.ids or m.id in args.ids]
    copies = copies_dir()
    copies.mkdir(parents=True, exist_ok=True)
    put_back_leftovers(mutants, copies)
    originals = {f: (CRATE / f).read_bytes() for f in sorted({m.file for m in mutants})}
    for m in mutants:
        if (n := originals[m.file].count(m.find)) != 1:
            fail(f"{m.id}: its find text occurs {n} times in {m.file}, not once; update mutants.toml")
    digests = {f: hashlib.sha256(b).hexdigest() for f, b in originals.items()}

    print(f"ai-check mutation run: {len(chosen)} mutants, command: {' '.join(COMMAND)}")
    print(f"workspace {ROOT}; CARGO_TARGET_DIR={os.environ.get('CARGO_TARGET_DIR', '(not set)')}")
    print("baseline, no mutant: ", end="", flush=True)
    base = run_tests(args.timeout)
    if base.kind != "survived":
        fail(f"the tests do not pass without a mutant ({base.text()}); fix that first")
    print(f"every test passes ({base.seconds:.0f} s)")

    rows: list[tuple[Mutant, Outcome]] = []
    try:
        for n, m in enumerate(chosen, 1):
            print(f"[{n:>2}/{len(chosen)}] {m.id:<4} {m.what} ... ", end="", flush=True)
            outcome = run_one(m, originals, copies, args.timeout)
            rows.append((m, outcome))
            print(outcome.text())
    except KeyboardInterrupt as e:
        print(f"\ninterrupted ({str(e) or 'Ctrl-C'}) after {len(rows)} of {len(chosen)} mutants")
    finally:
        # A second guard behind run_one's: whatever happened, every file ends as it was read at the start.
        with signals_held():
            for f, original in originals.items():
                if (CRATE / f).read_bytes() != original:
                    (CRATE / f).write_bytes(original)
                    print(f"note: put back {f} at the end")
        changed = [f for f, b in originals.items() if (CRATE / f).read_bytes() != b]
        if changed:
            fail(f"NOT put back: {', '.join(changed)}; the originals are in {copies}")
        for copy in copies.glob("*"):
            copy.unlink()
        print("source put back byte for byte: " + ", ".join(f"{f} (sha256 {d[:12]})" for f, d in digests.items()))

    print()
    print_table(rows, originals)
    counted = [(m, o) for m, o in rows if not m.equivalent]
    caught = [m for m, o in counted if o.caught]
    by = {k: sum(1 for _, o in counted if o.kind == k) for k in ("test", "build", "crash")}
    print()
    print(f"{len(caught)} of {len(counted)} mutants caught "
          f"({by['test']} by a failing test, {by['build']} by a failed build, {by['crash']} by a crash)")
    missed = [m.id for m, o in counted if not o.caught]
    if missed:
        print(f"not caught: {', '.join(missed)} (each one is a missing test, or a timeout or error to look at)")
    equivalent = [(m, o) for m, o in rows if m.equivalent]
    for m, o in equivalent:
        print(f"{m.id} is marked equivalent and {'survived, as expected' if not o.caught else 'was CAUGHT'}: "
              f"{m.equivalent}")
    complete = len(rows) == len(chosen)
    return 0 if complete and not missed and all(not o.caught for _, o in equivalent) else 1


if __name__ == "__main__":
    sys.exit(main())
