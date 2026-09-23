# Makefile to build a Tasmota .tapp file

# =============================================================================
# CONFIGURATION
# =============================================================================

VERSION := v$(shell cat VERSION.txt)
TARGET := ems

# UI language (spec 002): `make tapp LANG=en` builds an English .tapp.
# Only a command-line LANG counts — the environment locale is ignored.
ifeq ($(origin LANG),command line)
UILANG := $(LANG)
else
UILANG := de
endif

# Base directories
ROOT_DIR    := .
CLIENT_DIR  := ../frontend

# Directory structure
BUILD_DIR := $(ROOT_DIR)/build
TEST_DIR := $(ROOT_DIR)/tests

# Output files (non-German builds get a -<lang> suffix)
ifeq ($(UILANG),de)
TAPP := $(BUILD_DIR)/$(TARGET)-$(VERSION).tapp
else
TAPP := $(BUILD_DIR)/$(TARGET)-$(VERSION)-$(UILANG).tapp
endif
ZIP := $(BUILD_DIR)/$(TARGET)-$(VERSION).zip

# Source files (exlude test files)
APP_SRC := $(shell ls *.be)

# Integration files
INTEGRATION_SRC := $(wildcard integrations/*.be)

# Messaging files
MESSAGING_SRC := $(wildcard messaging/*.be)

# Frontend build (Vite). The UI JS/CSS is served from a CDN by default; only
# the index.html shell (+ lang.json) is packed into the .tapp. Override the
# asset source and CDN host on the command line, e.g.:
#   make                              # CDN (GitHub Pages) — default
#   make ASSET_BASE=self              # self-host: bundle assets into the .tapp
#   make ASSET_BASE=dev               # shell loads from a `npm run dev` server
#   make CDN_BASE_URL=https://cdn.ex  # point at a different CDN host
#   make ASSET_BASE=dev DEV_SERVER_URL=http://192.168.1.5:5173  # override NIC
ASSET_BASE     ?= cdn
CDN_BASE_URL   ?= https://gplug-ch.github.io/gplug-cdn
# empty -> Vite auto-detects this machine's LAN IP (dev shell runs on the device)
DEV_SERVER_URL ?=

# Vite output dir carrying the shell we pack (self/dev modes have own subdirs).
ifeq ($(ASSET_BASE),self)
FRONTEND_DIST := $(CLIENT_DIR)/dist/self
else ifeq ($(ASSET_BASE),dev)
FRONTEND_DIST := $(CLIENT_DIR)/dist/dev
else
FRONTEND_DIST := $(CLIENT_DIR)/dist/$(VERSION)
endif

# Test files
TEST_SRC := $(shell cd $(TEST_DIR); ls test_*.be)

# =============================================================================
# MAIN TARGETS
# =============================================================================

.DEFAULT_GOAL := all
.PHONY: all dev prod guard-cdn tapp zip clean minify frontend help deploy

all: clean tapp

# Build a .tapp whose shell loads the UI from a local `npm run dev` server
# (HMR), for developing against a real device. Flash the .tapp, then run
# `npm run dev` in ../frontend and open the device IP on the same network.
dev:
	@"$(MAKE)" ASSET_BASE=dev

minify: $(BUILD_DIR)
	@echo "Minifying Berry source files..."
	@for file in $(APP_SRC); do \
		python3 minify.py "$$file" "$(BUILD_DIR)/$$(basename "$$file")"; \
	done
	@for file in $(INTEGRATION_SRC); do \
		python3 minify.py "$$file" "$(BUILD_DIR)/$$(basename "$$file")"; \
	done
	@for file in $(MESSAGING_SRC); do \
		python3 minify.py "$$file" "$(BUILD_DIR)/$$(basename "$$file")"; \
	done
	@echo "Minification complete"

# Build the UI with Vite (hashed, minified, versioned) and pack only the shell.
# Only ASSET_BASE=self packs lang.json (~23 KB): that is the one mode whose
# shell fetches it on-device via /fs?name=lang.json. CDN/mirror builds get it
# from the bundle host (Vite emits it into the versioned dist dir next to the
# JS/CSS) and dev builds from the `npm run dev` server, so packing it there
# would cost a quarter of the .tapp for a path nobody takes — if the bundle
# host is unreachable the JS is gone too and the UI cannot boot at all. The
# device reads its build language from <html lang> in index.html instead
# (webservice.be _scan_language). bundle.py --lang-only always runs: it emits
# the line-per-key file for the device's line-by-line reader AND runs the i18n
# completeness check (FR-203/204), which must gate every build regardless of
# where the dictionary is served from.
frontend: | $(BUILD_DIR)
	@echo "Building frontend (lang=$(UILANG), assets=$(ASSET_BASE))..."
	cd $(CLIENT_DIR) && npm ci
	cd $(CLIENT_DIR) && APP_VERSION=$(VERSION) UILANG=$(UILANG) \
		ASSET_BASE=$(ASSET_BASE) CDN_BASE_URL=$(CDN_BASE_URL) \
		DEV_SERVER_URL=$(DEV_SERVER_URL) npm run build
	@if [ "$(ASSET_BASE)" = "self" ]; then \
		python3 $(CLIENT_DIR)/bundle.py --lang-only --quiet \
			--lang $(UILANG) --langout $(BUILD_DIR)/lang.json; \
	else \
		echo "$(ASSET_BASE) mode: lang.json served off-device, not packed into the .tapp"; \
		python3 $(CLIENT_DIR)/bundle.py --lang-only --quiet \
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

# Full production release: build the .tapp with the CDN asset base (bakes
# https://$(CDN_BASE_URL)/$(VERSION)/ into index.html) and publish the matching
# JS/CSS/lang.json bundle to the gplug-cdn repo (GitHub Pages) so that CDN URL
# resolves. Needs push access to github.com/gplug-ch/gplug-cdn (see
# ../README.md).
guard-cdn:
ifneq ($(ASSET_BASE),cdn)
	$(error make prod builds the public CDN release; ASSET_BASE must be "cdn" (got "$(ASSET_BASE)"))
endif

prod: guard-cdn clean tapp
	@echo "Publishing frontend assets to CDN ($(CDN_BASE_URL))..."
	cd $(CLIENT_DIR) && npm run deploy
	@echo "Production release complete: $(TAPP)"

# Upload the built .tapp to a device, deleting the previous versions FIRST.
# Tasmota runs autoexec.be from every *.tapp in the root, and the filename
# carries the version — so an upload alone leaves the old release in place and
# boots BOTH apps (double module graph, double sockets, ~2x boot heap on an
# ESP32-C3 -> fast-reboot loop). See deploy.sh.
#   make deploy DEVICE=192.168.1.42
#   make deploy DEVICE=gplug.local DRYRUN=1
#   make deploy DEVICE=... WEBUSER=admin WEBPASS=secret
deploy:
	@test -n "$(DEVICE)" || { echo "usage: make deploy DEVICE=<ip-or-host> [DRYRUN=1] [WEBUSER=.. WEBPASS=..]"; exit 2; }
	@DRYRUN="$(DRYRUN)" WEBUSER="$(WEBUSER)" WEBPASS="$(WEBPASS)" ./deploy.sh "$(DEVICE)" "$(TAPP)"

zip: $(ZIP_SRC) | $(BUILD_DIR)
	@echo "Creating ZIP archive: $(ZIP)"
	@echo "Including $(words $(ZIP_SRC)) source files..."
	@zip $(ZIP) README.md Makefile $(ZIP_SRC)

test:
	@echo "Running tests... - $(TEST_SRC)"
	@for test_file in $(TEST_SRC); do \
		echo "Executing $$test_file..."; \
		(cd $(TEST_DIR) && berry -m .. $$test_file) || exit 1; \
	done
	@echo "Executing vzev/test_vzev.be..."
	@(cd $(TEST_DIR)/vzev && berry -m ../.. test_vzev.be) || exit 1
	@echo "Executing netgate/test_net_gate.be..."
	@(cd $(TEST_DIR)/netgate && berry -m ../.. test_net_gate.be) || exit 1
	@echo "Executing battery/test_battery_site.be..."
	@(cd $(TEST_DIR)/battery && berry -m ../.. test_battery_site.be) || exit 1
	@echo "Executing modbus/test_modbus_site.be..."
	@(cd $(TEST_DIR)/modbus && berry -m ../.. test_modbus_site.be) || exit 1
	@echo "All tests passed successfully"

# =============================================================================
# MAINTENANCE TARGETS
# =============================================================================

.PHONY: clean

$(BUILD_DIR):
	@mkdir -p $(BUILD_DIR)

clean:
	@echo "Cleaning build directory..."
	@rm -rf $(BUILD_DIR)
	@echo "Build directory cleaned"

