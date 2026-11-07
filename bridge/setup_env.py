#!/usr/bin/env python3
"""Create or update the bridge's own Python environment (default ~/.aldine-bridge/venv).

Claude's shell commands run with this venv first on PATH, inside a sandbox with no
network access, so `pip install` cannot work during a chat: put what Claude may need
in PACKAGES and re-run this script (install.sh runs it too).

    python3 bridge/setup_env.py

The venv is built from a Python installed outside your home folder (the sandbox
denies reads under ~, and a venv only links to its base Python). uv, when present,
only installs the packages; it never provides the interpreter.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

VENV_DIR = Path(os.environ.get("ALDINE_BRIDGE_VENV", str(Path.home() / ".aldine-bridge" / "venv")))

# Useful next to LaTeX: plots and data for figures and tables, symbolic maths to
# check equations, bibliography and YAML parsing.
PACKAGES = [
    "numpy",
    "scipy",
    "sympy",
    "pandas",
    "matplotlib",
    "Pillow",
    "bibtexparser",
    "PyYAML",
    "tabulate",
]


def base_python() -> str:
    """An interpreter whose installation is outside the home folder."""
    home = str(Path.home())
    candidates = [os.environ.get("ALDINE_BRIDGE_PYTHON"), "/opt/homebrew/bin/python3",
                  "/usr/local/bin/python3", "/usr/bin/python3", shutil.which("python3")]
    for c in candidates:
        if not c or not Path(c).exists():
            continue
        try:
            prefix = subprocess.run([c, "-c", "import sys; print(sys.base_prefix)"],
                                    capture_output=True, text=True, check=True).stdout.strip()
        except Exception:
            continue
        if not prefix.startswith(home + os.sep):
            return c
    sys.exit("error: no python3 installed outside %s (the sandbox cannot read it there). "
             "Set ALDINE_BRIDGE_PYTHON to one, e.g. /usr/bin/python3." % home)


def run(*args: str) -> None:
    print("+", " ".join(args))
    subprocess.run(list(args), check=True)


def main() -> None:
    python = base_python()
    if not (VENV_DIR / "bin" / "python").exists():
        VENV_DIR.parent.mkdir(parents=True, exist_ok=True)
        run(python, "-m", "venv", str(VENV_DIR))
    venv_python = str(VENV_DIR / "bin" / "python")
    uv = shutil.which("uv")
    if uv:
        run(uv, "pip", "install", "--quiet", "--python", venv_python, *PACKAGES)
    else:
        run(venv_python, "-m", "pip", "install", "--quiet", "--upgrade", "pip")
        run(venv_python, "-m", "pip", "install", "--quiet", *PACKAGES)
    print("\nvenv ready: %s (%s)" % (VENV_DIR, ", ".join(PACKAGES)))


if __name__ == "__main__":
    main()
