"""Strategy research program: persistent experiment ledger, evaluation and a background runner.

- ledger.py:   experiments, decisions timeline and program state as JSON in .data/research/ (survives restarts)
- evaluate.py: research metrics on top of the engine's (capital, all-day Sharpe, cost split, bootstrap, gates)
- runner.py:   worker thread that runs queued experiments through the generic engine and saves each run
"""
