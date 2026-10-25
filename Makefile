VENV    := .venv
PYTHON  := $(VENV)/bin/python
HOST    ?= 0.0.0.0
PORT    ?= 8000
UI_PORT ?= 5173

.DEFAULT_GOAL := help
.PHONY: help install server client dev build clean clear-cache

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

$(VENV):
	python3 -m venv $(VENV)

install: $(VENV) ## Install backend (venv) and dashboard (npm) dependencies
	$(PYTHON) -m pip install -q -r requirements.txt
	cd client && npm install

server: ## Run the FastAPI server with auto-reload (HOST, PORT)
	$(PYTHON) -m uvicorn main:app --reload --host $(HOST) --port $(PORT)

client: ## Run the dashboard dev server (UI_PORT)
	cd client && API_URL=http://localhost:$(PORT) npm run dev -- --port $(UI_PORT)

dev: ## Run server and dashboard together; Ctrl-C stops both
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) --no-print-directory server & \
	$(MAKE) --no-print-directory client & \
	wait

build: ## Type-check and build the dashboard into client/dist
	cd client && npm run build

clean: ## Remove Python bytecode and the dashboard build
	find . -name __pycache__ -not -path './$(VENV)/*' -not -path './client/node_modules/*' -prune -exec rm -rf {} +
	rm -rf client/dist

clear-cache: ## Delete cached Breeze data in .cache/ (re-fetched on next use)
	rm -rf .cache
