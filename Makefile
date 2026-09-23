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


# Berry sources, flattened into the .tapp root (tests live in tests/, not here)
BERRY_SRC := $(wildcard $(BACKEND_DIR)/*.be $(BACKEND_DIR)/integrations/*.be)

# Frontend build (Vite). The UI JS/CSS and lang.json are always served from a
# CDN; only the index.html shell is packed into the .tapp. Override the asset
# source and CDN host on the command line, e.g.:
#   make                              # CDN (GitHub Pages) — default
#   make build-dev                    # shell loads from a `make dev` server
#   make CDN_BASE_URL=https://cdn.ex  # point at a different CDN host
#   make build-dev DEV_SERVER_URL=http://192.168.1.5:5173  # override NIC
ASSET_BASE     ?= cdn
CDN_BASE_URL   ?= https://gplug-ch.github.io/gplug-cdn
# empty -> Vite auto-detects this machine's LAN IP (dev shell runs on the device)
DEV_SERVER_URL ?=

# Output file (non-German builds get a -<lang> suffix, so the release
# variants ems-v1.2.0.tapp and ems-v1.2.0-en.tapp can sit side by side)
TAPP_SUFFIX := $(if $(filter-out de,$(UILANG)),-$(UILANG))
TAPP := $(BUILD_DIR)/$(TARGET)-$(VERSION)$(TAPP_SUFFIX).tapp

# `make release` collects the .tapps here (build/ is wiped by every build).
RELEASE_DIR := release
GH_REPO_URL := https://github.com/jluthiger/gplug-ems

# Vite output dir carrying the shell we pack (dev mode has its own subdir).
ifeq ($(ASSET_BASE),self)
$(error ASSET_BASE=self was removed: the UI is always served from the CDN (use ASSET_BASE=cdn, dev or a mirror URL))
else ifeq ($(ASSET_BASE),dev)
FRONTEND_DIST := $(FRONTEND_DIR)/dist/dev
else
FRONTEND_DIST := $(FRONTEND_DIR)/dist/$(VERSION)
endif

.DEFAULT_GOAL := build
.PHONY: build build-dev dev test test-backend test-frontend \
	release deploy-cdn flash sim-run sim-test sim-ui clean help \
	minify frontend tapp guard-release

# =============================================================================
# BUILD
# =============================================================================

build: clean tapp ## Build build/ems-v<version>.tapp (CDN shell; LANG=en for English)

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
# lang.json (~23 KB) is never packed: CDN/mirror builds get it from the bundle
# host (Vite emits it into the versioned dist dir next to the JS/CSS) and dev
# builds from the `make dev` server — if the bundle host is unreachable the JS
# is gone too and the UI cannot boot at all. The device reads its build
# language from <html lang> in index.html instead (webservice.be
# _scan_language). bundle.py --lang-only still runs for the i18n completeness
# check (FR-203/204), which gates every build; its output is discarded.
frontend:
	@mkdir -p $(BUILD_DIR)
	@echo "Building frontend (lang=$(UILANG), assets=$(ASSET_BASE))..."
	cd $(FRONTEND_DIR) && npm ci
	cd $(FRONTEND_DIR) && APP_VERSION=$(VERSION) UILANG=$(UILANG) \
		ASSET_BASE=$(ASSET_BASE) CDN_BASE_URL=$(CDN_BASE_URL) \
		DEV_SERVER_URL=$(DEV_SERVER_URL) KEEP_DIST=$(KEEP_DIST) npm run build
	python3 $(FRONTEND_DIR)/bundle.py --lang-only --quiet \
		--lang $(UILANG) --langout $(BUILD_DIR)/.lang-check.json \
		&& rm -f $(BUILD_DIR)/.lang-check.json
	cp $(FRONTEND_DIST)/index.html $(BUILD_DIR)/index.html
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

# Refuse to release anything that is not exactly origin/main with a fresh
# version: the tag check doubles as "VERSION.txt was not bumped". DRYRUN=1
# skips the repo/GitHub checks so the asset build can be tried anywhere.
guard-release:
ifneq ($(ASSET_BASE),cdn)
	$(error make release builds the public CDN release; ASSET_BASE must be "cdn" (got "$(ASSET_BASE)"))
endif
ifeq ($(DRYRUN),)
	@gh auth status >/dev/null 2>&1 || { echo "release: gh is not logged in (run 'gh auth login')"; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "release: working tree is not clean"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = main || { echo "release: not on branch main"; exit 1; }
	@git fetch --quiet origin main --tags
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "release: HEAD is not origin/main (pull/push first)"; exit 1; }
	@! git rev-parse -q --verify "refs/tags/$(VERSION)" >/dev/null || { echo "release: tag $(VERSION) already exists — bump VERSION.txt"; exit 1; }
	@test -z "$$(git ls-remote --tags origin "refs/tags/$(VERSION)")" || { echo "release: tag $(VERSION) already exists on origin — bump VERSION.txt"; exit 1; }
endif

# Build one .tapp variant (lang, asset base, KEEP_DIST) and collect it.
release-variant = @"$(MAKE)" build LANG=$(1) ASSET_BASE=$(2) KEEP_DIST=$(3) \
	&& cp $(BUILD_DIR)/*.tapp $(RELEASE_DIR)/

# Full production release of VERSION.txt:
#   1. build the German and English CDN .tapps (both into dist/<version>/,
#      KEEP_DIST=1 keeps the German bundle when the English one is built)
#   2. publish that bundle to the gplug-cdn repo (GitHub Pages) so the CDN URL
#      baked into index.html resolves — needs push access to
#      github.com/gplug-ch/gplug-cdn (see ems/README.md)
#   3. create the GitHub Release v<version> (gh creates the tag on HEAD) with
#      both .tapps; notes = .github/release-notes.md + the PR list that
#      --generate-notes groups via .github/release.yml
# Every sub-make names LANG and ASSET_BASE explicitly: a command-line value
# would otherwise leak into all of them via MAKEFLAGS.
#   make release            # the real thing
#   make release DRYRUN=1   # build the assets + notes into release/, publish nothing
release: guard-release ## Build de+en .tapps, publish the CDN bundle + GitHub Release (DRYRUN=1)
	@rm -rf $(RELEASE_DIR) && mkdir -p $(RELEASE_DIR)
	$(call release-variant,de,cdn,)
	$(call release-variant,en,cdn,1)
ifeq ($(DRYRUN),)
	@"$(MAKE)" deploy-cdn
else
	@echo "DRYRUN: skipping CDN deploy"
endif
	@sed 's/@VERSION@/$(VERSION)/g' .github/release-notes.md > $(RELEASE_DIR)/NOTES.md
	@ls -l $(RELEASE_DIR)
	@set -- gh release create "$(VERSION)" $(RELEASE_DIR)/*.tapp \
		--target "$$(git rev-parse HEAD)" --title "gPlug EMS $(VERSION)" \
		--notes-file $(RELEASE_DIR)/NOTES.md --generate-notes; \
	if [ -n "$(DRYRUN)" ]; then echo "DRYRUN: would run: $$*"; \
	else "$$@" && git fetch --quiet --tags \
		&& echo "released $(VERSION) -> $(GH_REPO_URL)/releases/tag/$(VERSION)"; fi

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
	@echo "Usage: make [target] [LANG=en] [ASSET_BASE=cdn|dev|<mirror-url>] [DEVICE=<ip>] [DRYRUN=1]"
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'
