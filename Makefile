# open-meeting-agent on macOS — `make help` lists everything.
#
#   make setup      Homebrew deps, the config file, a container engine, the bot image, the oma command
#   make doctor     what is ready
#
# Settings live in ~/.open-meeting-agent/config.json (`make config` creates it;
# `make set KV="KEY=value …"` changes keys). Nothing here needs sudo.

SHELL := /bin/bash
.DEFAULT_GOAL := help

OMA           := node $(CURDIR)/dist/oma.mjs
OMA_HOME      ?= $(HOME)/.open-meeting-agent
export OMA_HOME
CONFIG        := $(OMA_HOME)/config.json
SET           := node $(CURDIR)/scripts/set-config.mjs
BREW          := $(shell command -v brew 2>/dev/null)
BIN_DIR       ?= $(if $(BREW),$(shell brew --prefix)/bin,$(HOME)/.local/bin)
WHISPER_MODEL ?= large-v3-turbo
MODELS_DIR    := $(OMA_HOME)/models

.PHONY: help setup macos brew-deps node-check config set engine bot link doctor \
        plugin mcp-claude whisper auth-google auth-teams _auth \
        join live say end status deliver \
        install check build

help: ## this list
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[1m%-13s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "  e.g.  make join URL=https://meet.google.com/abc-defg-hij ACT=both TASKS=clickup CRM=hubspot DOC=notion"

# ── Setup ─────────────────────────────────────────────────────────────────────

setup: macos brew-deps node-check config engine bot link doctor ## everything needed to join meetings
	@echo
	@echo "✓ Ready. Next: transcription (make whisper, or make set KV=OMA_ASR_API_KEY=…),"
	@echo "  Claude Code (make plugin), then: make join URL=<meeting link>"

macos:
	@[ "$$(uname -s)" = Darwin ] || { echo "This Makefile is for macOS (on Linux, follow the README by hand)."; exit 1; }
	@[ -n "$(BREW)" ] || { echo "Homebrew is needed: https://brew.sh"; exit 1; }

brew-deps: macos ## Node and ffmpeg (Homebrew)
	@command -v node >/dev/null || brew install node
	@command -v ffmpeg >/dev/null || brew install ffmpeg
	@echo "✓ node $$(node --version), ffmpeg"

node-check:
	@node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
	  || { echo "Node >= 22.13 is needed (found $$(node --version)): brew upgrade node"; exit 1; }

config: ## create ~/.open-meeting-agent/config.json from config.example.json (kept if it exists)
	@mkdir -p "$(OMA_HOME)"
	@if [ -f "$(CONFIG)" ]; then echo "✓ $(CONFIG) (kept)"; \
	 else cp config.example.json "$(CONFIG)" && chmod 600 "$(CONFIG)" && echo "✓ created $(CONFIG) — fill in what you use"; fi

set: ## change config keys: make set KV="OMA_ACT=both OMA_TASKS_TARGET=clickup" (an empty value removes a key)
	@[ -n "$(KV)" ] || { echo 'usage: make set KV="KEY=value [KEY=value…]"'; exit 1; }
	@$(SET) $(KV)

engine: macos ## make sure a container engine runs (starts OrbStack / Docker Desktop / Colima when installed)
	@if docker info >/dev/null 2>&1 || podman info >/dev/null 2>&1; then echo "✓ container engine running"; exit 0; fi; \
	 if [ -d /Applications/OrbStack.app ]; then open -a OrbStack; \
	 elif [ -d /Applications/Docker.app ]; then open -a Docker; \
	 elif command -v colima >/dev/null; then colima start; \
	 else echo "No container engine. Install one, e.g.: brew install --cask orbstack (or Docker Desktop, Colima, Podman)"; exit 1; fi; \
	 printf "waiting for the engine"; \
	 for i in $$(seq 1 60); do docker info >/dev/null 2>&1 && { echo; echo "✓ container engine running"; exit 0; }; printf "."; sleep 2; done; \
	 echo; echo "The engine did not start in 2 minutes: open it by hand and run make setup again."; exit 1

bot: engine ## build the bot's container image (once; ~3 GB, a few minutes)
	@$(OMA) bot build

link: ## put `oma` on the PATH (a link to dist/oma.mjs in the Homebrew bin folder)
	@chmod +x dist/oma.mjs
	@mkdir -p "$(BIN_DIR)"
	@ln -sf "$(CURDIR)/dist/oma.mjs" "$(BIN_DIR)/oma"
	@echo "✓ $(BIN_DIR)/oma"

doctor: ## what is ready on this machine
	@$(OMA) doctor

# ── Optional ──────────────────────────────────────────────────────────────────

plugin: ## install the Claude Code plugin from this folder
	@command -v claude >/dev/null || { echo "Claude Code (claude) is not installed: https://claude.com/claude-code"; exit 1; }
	claude plugin marketplace add "$(CURDIR)"
	claude plugin install meeting-agent@open-meeting-agent

mcp-claude: ## Claude Code without the plugin: only the MCP server
	claude mcp add --transport stdio --scope user meeting-agent -- node "$(CURDIR)/dist/oma.mjs" mcp

whisper: macos ## local transcription: whisper.cpp + a model (WHISPER_MODEL=large-v3-turbo, ~1.6 GB)
	@command -v whisper-cli >/dev/null || brew install whisper-cpp
	@mkdir -p "$(MODELS_DIR)"
	@f="$(MODELS_DIR)/ggml-$(WHISPER_MODEL).bin"; \
	 if [ -f "$$f" ]; then echo "✓ $$f"; \
	 else curl -fL --progress-bar -o "$$f.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$(WHISPER_MODEL).bin" && mv "$$f.part" "$$f"; fi; \
	 $(SET) OMA_WHISPER_MODEL="$$f"

auth-google: ## sign the bot in to a Google account (it joins without the lobby)
	@$(MAKE) --no-print-directory _auth PROVIDER=google KEY=OMA_BOT_AUTH_GOOGLE

auth-teams: ## sign the bot in to a Microsoft account
	@$(MAKE) --no-print-directory _auth PROVIDER=teams KEY=OMA_BOT_AUTH_TEAMS

_auth:
	@cd bot && npm ci --no-audit --no-fund && npx patchright install chromium
	@mkdir -p "$(OMA_HOME)/auth"
	cd bot && npx tsx scripts/login.ts --provider $(PROVIDER) --out "$(OMA_HOME)/auth/$(PROVIDER).json"
	@$(SET) $(KEY)="$(OMA_HOME)/auth/$(PROVIDER).json"

# ── Using it ──────────────────────────────────────────────────────────────────

join: ## join a meeting: URL=… [ACT=after|during|both] [TASKS=…] [CRM=…] [DOC=…] [AUTONOMY=…] [REPO=owner/repo]
	@[ -n "$(URL)" ] || { echo "usage: make join URL=<meeting link> [ACT=both] [TASKS=clickup] [CRM=hubspot] [DOC=notion]"; exit 1; }
	@$(OMA) join "$(URL)" $(if $(ACT),--act $(ACT)) $(if $(TASKS),--tasks $(TASKS)) $(if $(CRM),--crm $(CRM)) \
	  $(if $(DOC),--doc $(DOC)) $(if $(AUTONOMY),--autonomy $(AUTONOMY)) $(if $(REPO),--repo $(REPO))

live: ## what is being said in the meeting [CALL=id]
	@$(OMA) live $(CALL)

say: ## post in the meeting chat: TEXT="…" CALL=id
	@[ -n "$(TEXT)" ] && [ -n "$(CALL)" ] || { echo 'usage: make say CALL=<call id> TEXT="…"  (oma list shows the ids)'; exit 1; }
	@$(OMA) say "$(CALL)" "$(TEXT)"

end: ## the agent leaves; the call is processed [CALL=id]
	@$(OMA) end $(CALL)

status: ## where the call is [CALL=id]
	@$(OMA) status $(CALL)

deliver: ## deliver the plan: tasks platform, CRM, document [CALL=id] [ONLY=tasks|crm|doc]
	@$(OMA) deliver $(CALL) $(if $(ONLY),--only $(ONLY))

# ── Development ───────────────────────────────────────────────────────────────

install: ## npm dependencies (host and bot)
	npm ci --no-audit --no-fund
	cd bot && npm ci --no-audit --no-fund

check: ## typecheck, tests, build, bot typecheck
	npm run typecheck && npm test && npm run build
	cd bot && npm run typecheck

build: ## rebuild dist/oma.mjs (commit it)
	npm run build
