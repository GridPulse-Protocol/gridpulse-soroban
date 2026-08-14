# GridPulse-Soroban developer targets.
#
# `stellar` is the Stellar CLI (see the README for install). It owns the
# `wasm32v1-none` target and the build settings the Soroban runtime requires.

.PHONY: build test fmt clippy clean help

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Compile the contract to wasm via Stellar CLI
	stellar contract build

test: ## Run the contract unit tests
	cargo test

fmt: ## Format all Rust code
	cargo fmt

clippy: ## Lint with clippy (warnings are errors)
	cargo clippy --all-targets -- -D warnings

clean: ## Remove build artifacts
	cargo clean
