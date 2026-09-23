# Makefile for the gPlug EMS: builds the Tasmota .tapp (Berry backend +
# Vite frontend shell), runs the tests, publishes the CDN bundle, flashes a
# device and wraps the simulator commands. Run `make help` for the target list.

# =============================================================================
# CONFIGURATION
# =============================================================================

VERSION := v$(shell cat VERSION.txt)
TARGET  := ems

BACKEND_DIR  := ems/backend
FRONTEND_DIR := ems/frontend
SIM_DIR      := simulator
BUILD_DIR    := build
TEST_DIR     := $(BACKEND_DIR)/tests

# UI language (spec 002): `make LANG=en` builds an English .tapp.
# Only a command-line LANG counts — the environment locale is ignored.
ifeq ($(origin LANG),command line)
UILANG := $(LANG)
else
UILANG := de
endif

# Output file (non-German builds get a -<lang> suffix)
ifeq ($(UILANG),de)
TAPP := $(BUILD_DIR)/$(TARGET)-$(VERSION).tapp
else
TAPP := $(BUILD_DIR)/$(TARGET)-$(VERSION)-$(UILANG).tapp
endif

# Berry sources, flattened into the .tapp root (tests live in tests/, not here)
BERRY_SRC := $(wildcard $(BACKEND_DIR)/*.be $(BACKEND_DIR)/integrations/*.be)

# Frontend build (Vite). The UI JS/CSS is served from a CDN by default; only
# the index.html shell is packed into the .tapp. Override the asset source and
# CDN host on the command line, e.g.:
#   make                              # CDN (GitHub Pages) — default
#   make build-self                   # self-host: bundle assets into the .tapp
#   make build-dev                    # shell loads from a `make dev` server
#   make CDN_BASE_URL=https://cdn.ex  # point at a different CDN host
#   make build-dev DEV_SERVER_URL=http://192.168.1.5:5173  # override NIC
ASSET_BASE     ?= cdn
CDN_BASE_URL   ?= https://gplug-ch.github.io/gplug-cdn
# empty -> Vite auto-detects this machine's LAN IP (dev shell runs on the device)
DEV_SERVER_URL ?=

# Vite output dir carrying the shell we pack (self/dev modes have own subdirs).
ifeq ($(ASSET_BASE),self)
FRONTEND_DIST := $(FRONTEND_DIR)/dist/self
else ifeq ($(ASSET_BASE),dev)
FRONTEND_DIST := $(FRONTEND_DIR)/dist/dev
else
FRONTEND_DIST := $(FRONTEND_DIR)/dist/$(VERSION)
endif

.DEFAULT_GOAL := build
.PHONY: build build-self build-dev dev test test-backend test-frontend \
	release deploy-cdn flash sim-run sim-test sim-ui clean help \
	minify frontend tapp guard-cdn

# =============================================================================
# BUILD
# =============================================================================

build: clean tapp ## Build build/ems-v<version>.tapp (CDN shell; LANG=en for English)

build-self: ## Build a self-hosted .tapp (JS/CSS + lang.json packed in, no CDN)
	@"$(MAKE)" build ASSET_BASE=self

# The shell loads the UI from a local `make dev` server (HMR), for developing
# against a real device. Flash the .tapp, run `make dev` and open the device IP
# on the same network.
build-dev: ## Build a .tapp whose shell loads the UI from `make dev` (HMR on a device)
	@"$(MAKE)" build ASSET_BASE=dev

dev: ## Run the frontend Vite dev server (HMR)
	cd $(FRONTEND_DIR) && { [ -d node_modules ] || npm ci; } && npm run dev

minify:
	@mkdir -p $(BUILD_DIR)
	@echo "Minifying Berry source files..."
	@for file in $(BERRY_SRC); do \
		python3 $(BACKEND_DIR)/minify.py "$$file" "$(BUILD_DIR)/$$(basename "$$file")"; \
	done
	@echo "Minification complete"

# Build the UI with Vite (hashed, minified, versioned) and pack only the shell.
# Only ASSET_BASE=self packs lang.json (~23 KB): that is the one mode whose
# shell fetches it on-device via /fs?name=lang.json. CDN/mirror builds get it
# from the bundle host (Vite emits it into the versioned dist dir next to the
# JS/CSS) and dev builds from the `make dev` server, so packing it there
# would cost a quarter of the .tapp for a path nobody takes — if the bundle
# host is unreachable the JS is gone too and the UI cannot boot at all. The
# device reads its build language from <html lang> in index.html instead
# (webservice.be _scan_language). bundle.py --lang-only always runs: it emits
# the line-per-key file for the device's line-by-line reader AND runs the i18n
# completeness check (FR-203/204), which must gate every build regardless of
# where the dictionary is served from.
frontend:
	@mkdir -p $(BUILD_DIR)
	@echo "Building frontend (lang=$(UILANG), assets=$(ASSET_BASE))..."
	cd $(FRONTEND_DIR) && npm ci
	cd $(FRONTEND_DIR) && APP_VERSION=$(VERSION) UILANG=$(UILANG) \
		ASSET_BASE=$(ASSET_BASE) CDN_BASE_URL=$(CDN_BASE_URL) \
		DEV_SERVER_URL=$(DEV_SERVER_URL) npm run build
	@if [ "$(ASSET_BASE)" = "self" ]; then \
		python3 $(FRONTEND_DIR)/bundle.py --lang-only --quiet \
			--lang $(UILANG) --langout $(BUILD_DIR)/lang.json; \
	else \
		echo "$(ASSET_BASE) mode: lang.json served off-device, not packed into the .tapp"; \
		python3 $(FRONTEND_DIR)/bundle.py --lang-only --quiet \
			--lang $(UILANG) --langout $(BUILD_DIR)/.lang-check.json \
			&& rm -f $(BUILD_DIR)/.lang-check.json; \
	fi
	cp $(FRONTEND_DIST)/index.html $(BUILD_DIR)/index.html
	@if [ "$(ASSET_BASE)" = "self" ]; then \
		echo "self-host mode: packing lang.json + hashed JS/CSS into the .tapp"; \
		cp $(FRONTEND_DIST)/*.js $(FRONTEND_DIST)/*.css $(BUILD_DIR)/; \
	fi
	@cp VERSION.txt $(BUILD_DIR)/VERSION.txt

tapp: minify frontend
	@echo "Building TAPP file: $(TAPP)"
	zip -0 -j $(TAPP) $(BUILD_DIR)/* -x '*.tapp'
	@echo "TAPP file created successfully: $(TAPP)"

# =============================================================================
# TEST
# =============================================================================

test: test-backend test-frontend ## Run all EMS tests (Berry + frontend)

# Top-level tests run from tests/ with the backend as module path; each
# tests/<group>/ subdirectory runs from there, one level deeper.
test-backend: ## Run the Berry backend tests
	@for f in $(TEST_DIR)/test_*.be; do \
		echo "Executing $$(basename $$f)..."; \
		(cd $(TEST_DIR) && berry -m .. $$(basename $$f)) || exit 1; \
	done
	@for f in $(TEST_DIR)/*/test_*.be; do \
		d=$$(dirname $$f); \
		echo "Executing $${d#$(TEST_DIR)/}/$$(basename $$f)..."; \
		(cd $$d && berry -m ../.. $$(basename $$f)) || exit 1; \
	done
	@echo "All Berry tests passed"

test-frontend: ## Run the frontend node tests
	cd $(FRONTEND_DIR) && { [ -d node_modules ] || npm ci; } && npm test

# =============================================================================
# RELEASE / DEPLOY
# =============================================================================

guard-cdn:
ifneq ($(ASSET_BASE),cdn)
	$(error make release builds the public CDN release; ASSET_BASE must be "cdn" (got "$(ASSET_BASE)"))
endif

# Full production release: build the .tapp with the CDN asset base (bakes
# $(CDN_BASE_URL)/$(VERSION)/ into index.html) and publish the matching
# JS/CSS/lang.json bundle to the gplug-cdn repo (GitHub Pages) so that CDN URL
# resolves. Needs push access to github.com/gplug-ch/gplug-cdn (see
# ems/README.md).
release: guard-cdn build ## Build the CDN .tapp and publish its bundle to the CDN
	@"$(MAKE)" deploy-cdn

deploy-cdn: ## Publish the built frontend bundle (dist/<version>) to the CDN
	@echo "Publishing frontend assets to CDN ($(CDN_BASE_URL))..."
	cd $(FRONTEND_DIR) && APP_VERSION=$(VERSION) npm run deploy

# Upload the built .tapp to a device, deleting the previous versions FIRST.
# Tasmota runs autoexec.be from every *.tapp in the root, and the filename
# carries the version — so an upload alone leaves the old release in place and
# boots BOTH apps (double module graph, ~2x boot heap on an ESP32-C3 ->
# fast-reboot loop). See ems/backend/deploy.sh.
#   make flash DEVICE=192.168.1.42
#   make flash DEVICE=gplug.local DRYRUN=1
#   make flash DEVICE=... WEBUSER=admin WEBPASS=secret
flash: ## Upload the .tapp to DEVICE=<ip> (removes stale .tapps; DRYRUN=1)
	@test -n "$(DEVICE)" || { echo "usage: make flash DEVICE=<ip-or-host> [DRYRUN=1] [WEBUSER=.. WEBPASS=..]"; exit 2; }
	@DRYRUN="$(DRYRUN)" WEBUSER="$(WEBUSER)" WEBPASS="$(WEBPASS)" $(BACKEND_DIR)/deploy.sh "$(DEVICE)" "$(TAPP)"

# =============================================================================
# SIMULATOR
# =============================================================================

sim-run: ## Run the simulator backend (Spring Boot, port 9090)
	cd $(SIM_DIR)/backend && ./gradlew bootRun

sim-test: ## Run the simulator backend tests
	cd $(SIM_DIR)/backend && ./gradlew test

sim-ui: ## Build the simulator UI into the backend's static resources
	cd $(SIM_DIR)/frontend && yarn deploy

# =============================================================================
# MAINTENANCE
# =============================================================================

clean: ## Remove the build directory
	@rm -rf $(BUILD_DIR)
	@echo "Build directory cleaned"

help: ## List the targets
	@echo "Usage: make [target] [LANG=en] [ASSET_BASE=cdn|self|dev] [DEVICE=<ip>]"
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'
