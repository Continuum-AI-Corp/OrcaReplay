"""Attaching the handler to a graph nobody edited, without paying for langchain in every process.

## How it attaches

`langchain_core.tracers.context.register_configure_hook(var, inheritable, cls, env_var)` appends to
a list that `CallbackManager._configure` walks on every run. For each entry it does, in effect:

    create_one = env_var is not None and env_var_is_set(env_var) and handler_class is not None
    if var.get() is not None or create_one:
        handler = var.get() or handler_class()
        if not any(isinstance(h, handler_class) for h in manager.handlers):
            manager.add_handler(handler, inheritable)

Three things follow, and the package is shaped around them:

  - **`env_var` is the gate, and it is read per run.** `env_var_is_set` is true for any value that
    is not `""`, `"0"`, `"false"` or `"False"` -- measured, true for a Windows path -- so
    `ORCA_AGENT_SPANS` can be the gate directly. Nothing is added to a manager in a process orca is
    not recording, and the decision is made per `_configure` rather than frozen at registration.
  - **`handler_class()` runs before the `isinstance` check.** An instance is constructed on every
    configure call and usually thrown away, which is why `OrcaCallbackHandler.__init__` does
    nothing and why the state it would have held is module-level instead.
  - **Registering twice cannot double-report.** The `isinstance` check is against the class, so a
    second hook for the same class adds no second handler. `install` still guards, because a
    pointless second instance per configure is still waste.

`inheritable=True` because a node runs as a child of the graph's own run; a non-inheritable handler
would see the graph and none of its nodes.

## Why it is installed lazily

Importing `langchain_core.tracers.context` costs **617 ms** on this machine against an interpreter
that starts in about 50. `orca record` puts the bootstrap that calls `install()` in front of *every*
Python process a recording starts -- `python --version` included -- so doing that import eagerly
would tax processes that will never touch a graph. An agent that shells out to `python` twenty
times would pay twelve seconds for a package it did not use.

So `install` arms a `sys.meta_path` finder and returns. The finder registers the hook the first time
anything under `langgraph` is imported, and a process that imports langgraph is a process already
paying a second for it -- measured, `import langgraph.graph` is 1037 ms, most of it langchain_core.

**Only the `langgraph` root, and this is a correctness constraint rather than a preference.** The
finder runs inside `_find_and_load_unlocked`, *after* that function's `sys.modules` check. Importing
`langchain_core.tracers.context` from a `find_spec` for a `langchain_core.*` name would re-enter the
load of `langchain_core` itself, and for a top-level name CPython does not re-check `sys.modules`
before executing -- so the package would be executed twice, leaving two module objects and
submodules bound to the older one. Triggering on `langgraph` has no such loop: langchain_core does
not import langgraph.

Waiting for `langchain_core.tracers.context` to appear in `sys.modules` on its own was the first
design and it does not work: measured across the 164 `find_spec` calls of one
`from langgraph.graph import StateGraph`, it is loaded for none of them. `_configure` imports it at
the first invoke, which is already too late to register in.
"""

from __future__ import annotations

import atexit
import os
import sys
from contextvars import ContextVar
from typing import Any

from .handler import SPANS_ENV, OrcaCallbackHandler, report_losses

#: langchain-core's own escape hatch: setting this to a handler makes `_configure` use that instance
#: instead of constructing one. Exposed for tests and for anyone who wants a handler of their own.
HANDLER_VAR: ContextVar[Any] = ContextVar("orca_langgraph_handler", default=None)

#: The import root that triggers the lazy registration. See the module docstring for why it is this
#: one and not `langchain_core`.
TRIGGER = "langgraph"

_registered = False
_finder: _LazyInstaller | None = None


def _register() -> bool:
    """Append the hook. Returns whether it is now in place."""
    global _registered
    if _registered:
        return True
    try:
        from langchain_core.tracers.context import register_configure_hook
    except Exception:  # noqa: BLE001 - langchain-core is not here; that is not a failure
        return False
    try:
        register_configure_hook(HANDLER_VAR, True, OrcaCallbackHandler, SPANS_ENV)
    except Exception:  # noqa: BLE001 - a langchain-core whose signature moved
        return False
    _registered = True
    # Only in a process that got this far, so a `python --version` under a recording registers
    # nothing. `report_losses` writes at most one line and only when something was actually lost.
    atexit.register(report_losses)
    return True


class _LazyInstaller:
    """A meta-path finder that registers the hook and then gets out of the way.

    It never claims a module: `find_spec` returns None on every path, so the ordinary finders load
    langgraph exactly as they would have. The return value is not the point -- being *asked* is.
    """

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> None:
        try:
            if fullname != TRIGGER and not fullname.startswith(TRIGGER + "."):
                return None
            # Before the import below, so a nested `find_spec` for a langgraph name cannot start a
            # second registration. Also what makes uninstalling safe to do first.
            _uninstall()
            _register()
        except Exception:  # noqa: BLE001 - an import must not fail because of a debugging aid
            _uninstall()
        return None


def _uninstall() -> None:
    """Take the finder off `sys.meta_path`. Idempotent, and never raises."""
    global _finder
    finder, _finder = _finder, None
    if finder is None:
        return
    try:
        sys.meta_path.remove(finder)
    except ValueError:
        pass  # somebody else rebuilt meta_path; nothing to do


def install() -> bool:
    """Arrange for the handler to attach to LangGraph runs. Returns whether anything was done.

    False, quietly, in the cases that are not errors: orca is not recording, the hook is already
    registered, or langchain-core is absent from a process that has already imported langgraph.
    Those are the normal state of a machine that merely has this package on it.

    Registers immediately when langgraph is already imported -- the cost is spent, and a caller who
    imports the graph before calling `install` would otherwise never be armed, because the trigger
    has already fired. Otherwise it arms the finder and returns; see the module docstring.
    """
    global _finder
    if _registered:
        return False
    # The same variable langchain-core will gate on. Checked here too so that a process orca is not
    # recording does not even carry the finder.
    if not os.environ.get(SPANS_ENV):
        return False
    if TRIGGER in sys.modules:
        return _register()
    if _finder is not None:
        return False
    _finder = _LazyInstaller()
    # In front, so the registration happens before any other finder can resolve langgraph -- a
    # finder that loads it from a zip or a bundle would otherwise satisfy the import first and the
    # trigger would never be asked.
    sys.meta_path.insert(0, _finder)
    return True


def uninstall() -> bool:
    """Undo `install` as far as it can be undone. Returns whether the finder was still armed.

    The registered hook itself stays: langchain-core offers no way to remove one, and the entry is
    inert without `ORCA_AGENT_SPANS` anyway. This exists so a test can arm the finder twice.
    """
    armed = _finder is not None
    _uninstall()
    return armed
