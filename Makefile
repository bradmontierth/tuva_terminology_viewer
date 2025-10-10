SHELL := /bin/bash

# Usage:
#   make dev DATASET=ndc INPUT=../data/versioned_terminology/latest/ndc.csv.gz PORT=8000

.PHONY: dev
dev:
	@./scripts/dev-local.sh --dataset "$(DATASET)" $(if $(INPUT),--input "$(INPUT)") $(if $(PORT),--port "$(PORT)")

.PHONY: dev-all
dev-all:
	@./scripts/dev-local-all.sh $(if $(VERSIONS),--versions "$(VERSIONS)") $(if $(PORT),--port "$(PORT)")
