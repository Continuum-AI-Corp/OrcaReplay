"""Puts the SDK on `sys.path` so the suite runs from a clean checkout.

`orca_trace` has no build step and no dependencies; requiring `pip install -e` before
`python3 -m pytest python/` would add one for no benefit.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
