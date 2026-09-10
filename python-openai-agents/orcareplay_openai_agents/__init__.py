"""Record the OpenAI Agents SDK's own run structure into an OrcaReplay trace.

Inert unless orca is recording: everything here keys off the `ORCA_AGENT_SPANS` environment
variable, which only `orca record` sets. See `processor` for what it captures and why it leaves the
model exchanges to the proxy.
"""

from .processor import KEEP_ENV, SPANS_ENV, OrcaTracingProcessor, install

__all__ = ["OrcaTracingProcessor", "install", "SPANS_ENV", "KEEP_ENV"]
__version__ = "0.1.0"
