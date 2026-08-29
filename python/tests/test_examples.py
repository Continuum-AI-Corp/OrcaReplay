"""The worked example is documentation that runs, so it is tested like anything else."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from conftest import repo_root

SCRIPT = Path(__file__).resolve().parents[1] / "examples" / "analyze.py"


@pytest.fixture
def analysis(example_run: Path) -> str:
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(example_run)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stderr == "", "a clean trace must report no problems"
    return result.stdout


def test_reports_the_run_and_its_integrity(analysis: str) -> None:
    assert "run_9f2c14a03b71" in analysis
    assert "integrity: OK" in analysis


def test_answers_the_token_question(analysis: str) -> None:
    """Totals are paired back through `causes`, so this also exercises the causal DAG."""
    assert "claude-opus-5" in analysis
    assert "40350" in analysis and "934" in analysis


def test_answers_the_churn_question(analysis: str) -> None:
    assert "src/auth.ts" in analysis
    assert "+18/-4" in analysis


def test_shows_that_a_fork_target_moved(analysis: str) -> None:
    assert "snapped back from 20" in analysis


def test_runs_with_no_argument() -> None:
    """The default path is the repo's example trace, so `python3 examples/analyze.py` just works."""
    if repo_root() is None:
        pytest.skip("not running inside an OrcaReplay checkout")
    result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
