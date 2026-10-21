"""Local pytest evidence collector. Its output is captured by the controller."""
import json
import os

_collected = []
_outcomes = []
_cwds = set()

def pytest_sessionstart(session):
    _cwds.add(os.path.realpath(os.getcwd()))

def pytest_collection_finish(session):
    _cwds.add(os.path.realpath(os.getcwd()))
    _collected.extend(item.nodeid for item in session.items)

def pytest_runtest_logreport(report):
    _cwds.add(os.path.realpath(os.getcwd()))
    _outcomes.append({"nodeid": report.nodeid, "when": report.when, "outcome": report.outcome})

def pytest_sessionfinish(session, exitstatus):
    filename = os.environ["CODEX_DSH_PYTEST_REPORT"]
    with open(filename, "x", encoding="utf-8") as handle:
        json.dump({"cwd": os.path.realpath(os.getcwd()), "observedCwds": sorted(_cwds), "collected": _collected, "outcomes": _outcomes,
                   "exitstatus": int(exitstatus), "finished": True}, handle)
