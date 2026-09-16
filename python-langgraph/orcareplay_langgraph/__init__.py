"""Record which LangGraph node did what, into an OrcaReplay trace.

Inert unless orca is recording: everything here keys off the `ORCA_AGENT_SPANS` environment
variable, which only `orca record` sets. See `handler` for what it captures and why it leaves the
model exchanges to the proxy, and `hook` for how it attaches to a graph nobody edited.
"""

from .handler import PACKAGE, SPAN_END, SPAN_START, SPANS_ENV, OrcaCallbackHandler
from .hook import HANDLER_VAR, install, uninstall

__all__ = [
    "HANDLER_VAR",
    "PACKAGE",
    "SPANS_ENV",
    "SPAN_END",
    "SPAN_START",
    "OrcaCallbackHandler",
    "install",
    "uninstall",
]
__version__ = "0.1.0"
