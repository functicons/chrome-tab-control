SKILL_DIR = skills/chrome-tab-control
CLI       = $(SKILL_DIR)/scripts/tab-control-cli.mjs

.PHONY: help check install-tab-proxy install-skill icons list

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

check: ## Verify required dependencies
	@scripts/check.sh

install-tab-proxy: ## Install tab proxy for Chrome native messaging
	scripts/install-tab-proxy.sh

install-skill: ## Install as Claude Code skill (~/.claude/skills/)
	scripts/install-skill.sh

icons: ## Regenerate extension icons
	node scripts/gen-icons.mjs

list: ## List shared tabs
	@node $(CLI) list
