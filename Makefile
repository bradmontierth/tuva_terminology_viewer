SHELL := /bin/bash

# Usage:
#   make dev DATASET=ndc INPUT=../data/versioned_terminology/latest/ndc.csv.gz PORT=8000

.PHONY: dev
dev:
	@./scripts/dev-local.sh --dataset "$(DATASET)" $(if $(INPUT),--input "$(INPUT)") $(if $(PORT),--port "$(PORT)")

.PHONY: dev-all
dev-all:
	@./scripts/dev-local-all.sh $(if $(VERSIONS),--versions "$(VERSIONS)") $(if $(PORT),--port "$(PORT)")

# Deploy the API stack (Lambda + EFS) using containerized SAM build, then run
# the EFS sync Lambda to copy .sqlite files from S3 to EFS.
#
# Usage example:
#   make deploy-efs-sync \
#     PROFILE=term \
#     BUCKET=tuva-public-resources \
#     PREFIX=terminology-viewer/api_sqlite \
#     AP_ARN=arn:aws:elasticfilesystem:us-east-1:6968:access-point/fsap-XXXX \
#     SUBNETS=subnet-aaa,subnet-bbb \
#     SG=sg-xxxx \
#     ORIGIN=https://your.site \
#     STACK=TuvaSearchApi \
#     OVERWRITE=0 DATASETS=ndc,loinc
#
.PHONY: deploy-efs-sync
deploy-efs-sync:
	$(eval EFS_OUT := scripts/outputs/efs.json)
	$(eval _AP_ARN := $(or $(AP_ARN),$(shell jq -r '.AccessPointArn // empty' $(EFS_OUT) 2>/dev/null)))
	$(eval _SUBNETS := $(or $(SUBNETS),$(shell jq -r '.SubnetIds | join(",")' $(EFS_OUT) 2>/dev/null)))
	$(eval _SG := $(or $(SG),$(shell jq -r '.LambdaSecurityGroupId // empty' $(EFS_OUT) 2>/dev/null)))
	$(eval _STACK := $(if $(STACK),$(STACK),TuvaSearchApi))
	$(eval _BUCKET := $(if $(BUCKET),$(BUCKET),tuva-public-resources))
	$(eval _PREFIX := $(if $(PREFIX),$(PREFIX),terminology-viewer/api_sqlite))
	$(eval _ORIGIN := $(if $(ORIGIN),$(ORIGIN),*))
	$(eval _PROVISIONED := $(if $(PROVISIONED),$(PROVISIONED),1))
	@if [ -z "$(_AP_ARN)" ] || [ -z "$(_SUBNETS)" ] || [ -z "$(_SG)" ]; then \
	  echo "Missing EFS parameters. Provide AP_ARN, SUBNETS, SG, or ensure $(EFS_OUT) exists." >&2; exit 1; \
	fi
	@search_api/deploy.sh --use-container \
	  $(if $(PROFILE),--profile "$(PROFILE)") \
	  --bucket "$(_BUCKET)" \
	  --stack "$(_STACK)" \
	  --prefix "$(_PREFIX)" \
	  --allow-origins "$(_ORIGIN)" \
	  --efs-ap-arn "$(_AP_ARN)" \
	  --subnet-ids "$(_SUBNETS)" \
	  --sg-ids "$(_SG)" \
	  --provisioned $(_PROVISIONED)
	@./scripts/run-efs-sync.sh \
	  $(if $(PROFILE),--profile "$(PROFILE)") \
	  --stack "$(_STACK)" \
	  $(if $(OVERWRITE),--overwrite $(OVERWRITE)) \
	  $(if $(DATASETS),--datasets "$(DATASETS)")

.PHONY: deploy-api
deploy-api:
	$(eval EFS_OUT := scripts/outputs/efs.json)
	$(eval _AP_ARN := $(or $(AP_ARN),$(shell jq -r '.AccessPointArn // empty' $(EFS_OUT) 2>/dev/null)))
	$(eval _SUBNETS := $(or $(SUBNETS),$(shell jq -r '.SubnetIds | join(",")' $(EFS_OUT) 2>/dev/null)))
	$(eval _SG := $(or $(SG),$(shell jq -r '.LambdaSecurityGroupId // empty' $(EFS_OUT) 2>/dev/null)))
	$(eval _STACK := $(if $(STACK),$(STACK),TuvaSearchApi))
	$(eval _BUCKET := $(if $(BUCKET),$(BUCKET),tuva-public-resources))
	$(eval _PREFIX := $(if $(PREFIX),$(PREFIX),terminology-viewer/api_sqlite))
	$(eval _ORIGIN := $(if $(ORIGIN),$(ORIGIN),*))
	$(eval _PROVISIONED := $(if $(PROVISIONED),$(PROVISIONED),1))
	@if [ -z "$(_AP_ARN)" ] || [ -z "$(_SUBNETS)" ] || [ -z "$(_SG)" ]; then \
	  echo "Missing EFS parameters. Provide AP_ARN, SUBNETS, SG, or ensure $(EFS_OUT) exists." >&2; exit 1; \
	fi
	@search_api/deploy.sh --use-container \
	  $(if $(PROFILE),--profile "$(PROFILE)") \
	  --bucket "$(_BUCKET)" \
	  --stack "$(_STACK)" \
	  --prefix "$(_PREFIX)" \
	  --allow-origins "$(_ORIGIN)" \
	  --efs-ap-arn "$(_AP_ARN)" \
	  --subnet-ids "$(_SUBNETS)" \
	  --sg-ids "$(_SG)" \
	  --provisioned $(_PROVISIONED)

.PHONY: sync-efs
sync-efs:
	$(eval _STACK := $(if $(STACK),$(STACK),TuvaSearchApi))
	@./scripts/run-efs-sync.sh \
	  $(if $(PROFILE),--profile "$(PROFILE)") \
	  --stack "$(_STACK)" \
	  $(if $(OVERWRITE),--overwrite $(OVERWRITE)) \
	  $(if $(DATASETS),--datasets "$(DATASETS)")

# Build SPA with API backend and deploy to S3/CloudFront
# Usage:
#   make deploy-frontend PROFILE=term SPA_BUCKET=tuva-public-resources \
#     [SPA_PREFIX=terminology-viewer] [STACK=TuvaSearchApi] \
#     [API_URL=https://...execute-api...] [CF_DIST_ID=E123...]
.PHONY: deploy-frontend
deploy-frontend:
	$(eval _STACK := $(if $(STACK),$(STACK),TuvaSearchApi))
	@if [ -z "$(SPA_BUCKET)" ]; then echo "SPA_BUCKET is required" >&2; exit 1; fi
	@API_BASE="$(API_URL)"; \
	if [ -z "$$API_BASE" ]; then \
	  API_BASE=$$(aws $(if $(PROFILE),--profile "$(PROFILE)") cloudformation describe-stacks --stack-name "$(_STACK)" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text); \
	  if [ -z "$$API_BASE" ] || [ "$$API_BASE" = "None" ]; then echo "Failed to resolve API Url from stack $(_STACK)" >&2; exit 1; fi; \
	fi; \
	echo "Building SPA with API base: $$API_BASE"; \
	(cd csv_viewer_app && REACT_APP_SEARCH_BACKEND=api REACT_APP_SEARCH_API_BASE_URL="$$API_BASE" REACT_APP_DISABLE_SQLITE_SW=1 npm run build); \
	echo "Deploying SPA to s3://$(SPA_BUCKET)$(if $(SPA_PREFIX),/$(SPA_PREFIX),) ..."; \
	csv_viewer_app/scripts/deploy-to-s3.sh "$(SPA_BUCKET)" --no-build $(if $(SPA_PREFIX),--prefix "$(SPA_PREFIX)") $(if $(CF_DIST_ID),--cf-dist-id "$(CF_DIST_ID)") $(if $(PROFILE),--profile "$(PROFILE)") $(if $(REGION),--region "$(REGION)")

# Build SQLite assets for a version, publish to S3, then sync EFS.
# Defaults: VERSION=latest, THRESHOLD=1000, SHARDS=1, BUCKET=tuva-public-resources,
# PREFIX=terminology-viewer/api_sqlite
# Optional: DATASETS=ndc,loinc to limit publishing and syncing.
.PHONY: build-publish-sync
build-publish-sync:
	$(eval _VERSION := $(if $(VERSION),$(VERSION),latest))
	$(eval _THRESHOLD := $(if $(THRESHOLD),$(THRESHOLD),1000))
	$(eval _BUILD_THRESHOLD := $(if $(ALWAYS_BUILD_CHANGED),0,$(_THRESHOLD)))
	$(eval _SHARDS := $(if $(SHARDS),$(SHARDS),1))
	$(eval _BUCKET := $(if $(BUCKET),$(BUCKET),tuva-public-resources))
	$(eval _PREFIX := $(if $(PREFIX),$(PREFIX),terminology-viewer/api_sqlite))
	$(eval _SRC_BUCKET := $(if $(SRC_BUCKET),$(SRC_BUCKET),tuva-public-resources))
	$(eval _STACK := $(if $(STACK),$(STACK),TuvaSearchApi))
	@set -e; \
	echo "Resolving version via header-crosswalk ..."; \
	(cd csv_viewer_app && npm run generate:crosswalk >/dev/null 2>&1 || true); \
	BASE_URL="https://$(_SRC_BUCKET).s3.amazonaws.com"; \
	(cd csv_viewer_app && TUVA_DATA_BASE_URL="$$BASE_URL" node scripts/generateFileIdentityCrosswalk.js >/dev/null 2>&1 || true); \
	PUBLISHED_LATEST=$$(node -e 'try{const f=require("./csv_viewer_app/public/data/header-crosswalk.json");console.log((f._meta&&f._meta.latestVersion)||"");}catch(e){console.log("")}' ); \
	VER="$(_VERSION)"; \
	if [ "$$VER" = "latest" ] && [ -n "$$PUBLISHED_LATEST" ]; then VER="$$PUBLISHED_LATEST"; fi; \
	echo "Using version: $$VER"; \
	CHANGED=$$(node scripts/list-changed-datasets.js 2>/dev/null || true); \
	if [ -z "$$CHANGED" ]; then \
	  echo "No dataset changes detected. Skipping build/publish/sync."; \
	  exit 0; \
	fi; \
	echo "Changed datasets: $$CHANGED"; \
	echo "Syncing CSV inputs for changed datasets from s3://$(_SRC_BUCKET) (version $$VER) ..."; \
	for d in $$(echo "$$CHANGED" | tr ',' ' '); do \
	  aws $(if $(PROFILE),--profile "$(PROFILE)") s3 sync \
	    "s3://$(_SRC_BUCKET)/versioned_terminology/$$VER/" \
	    "$(CURDIR)/data/versioned_terminology/$$VER/" \
	    --exclude "*" --include "$$d*.csv*" --size-only || true; \
	  aws $(if $(PROFILE),--profile "$(PROFILE)") s3 sync \
	    "s3://$(_SRC_BUCKET)/versioned_value_sets/$$VER/" \
	    "$(CURDIR)/data/versioned_value_sets/$$VER/" \
	    --exclude "*" --include "$$d*.csv*" --size-only || true; \
	  aws $(if $(PROFILE),--profile "$(PROFILE)") s3 sync \
	    "s3://$(_SRC_BUCKET)/versioned_provider_data/$$VER/" \
	    "$(CURDIR)/data/versioned_provider_data/$$VER/" \
	    --exclude "*" --include "$$d*.csv*" --size-only || true; \
	done; \
	DS_ARGS=$$(for d in $$(echo "$$CHANGED" | tr ',' ' '); do printf -- " --dataset %s" "$$d"; done); \
	echo "Building SQLite assets for version $$VER (threshold=$(_BUILD_THRESHOLD), shards=$(_SHARDS)) ..."; \
	(cd csv_viewer_app && npm run build:sqlite:batch -- --threshold "$(_BUILD_THRESHOLD)" --shard-count "$(_SHARDS)" $$DS_ARGS "$(CURDIR)/data/versioned_terminology/$$VER" "$(CURDIR)/data/versioned_value_sets/$$VER" "$(CURDIR)/data/versioned_provider_data/$$VER" ); \
	PUBLISH_LIST=$$( \
	  OK=(); \
	  for d in $$(echo "$$CHANGED" | tr ',' ' '); do \
	    f="$(CURDIR)/csv_viewer_app/public/data/sqlite/$$d/$$d.sqlite"; \
	    if [ -f "$$f" ]; then OK+=("$$d"); fi; \
	  done; \
	  printf "%s" "$${OK[*]}" | tr ' ' ',' \
	); \
	if [ -n "$$PUBLISH_LIST" ]; then \
	  echo "Publishing .sqlite to s3://$(_BUCKET)/$(_PREFIX)/ for: $$PUBLISH_LIST ..."; \
	  csv_viewer_app/scripts/publish-api-sqlite.sh --dest-bucket "$(_BUCKET)" --prefix "$(_PREFIX)" --datasets "$$PUBLISH_LIST" $(if $(PROFILE),--profile "$(PROFILE)"); \
	  echo "Syncing EFS for: $$PUBLISH_LIST ..."; \
	  SYNC_JSON="scripts/outputs/efs_sync_$$(date +%Y%m%d_%H%M%S).json"; \
	  ./scripts/run-efs-sync.sh $(if $(PROFILE),--profile "$(PROFILE)") --stack "$(_STACK)" --datasets "$$PUBLISH_LIST" $(if $(OVERWRITE),--overwrite $(OVERWRITE)) --out "$$SYNC_JSON"; \
	  SUMMARY="scripts/outputs/build_publish_sync_$$(date +%Y%m%d_%H%M%S).json"; \
	  STARTED=$$(date -Iseconds); \
	  FINISHED=$$(date -Iseconds); \
	  jq -n --arg version "$$VER" --arg started "$$STARTED" --arg finished "$$FINISHED" \
	    --arg changed "$$CHANGED" --arg published "$$PUBLISH_LIST" \
	    --slurpfile sync "$$SYNC_JSON" \
	    '{version:$$version, startedAt:$$started, finishedAt:$$finished, changed:($$changed|split(",")|map(select(length>0))), published:($$published|split(",")|map(select(length>0))), efsSync: ($$sync|length>0 and $$sync[0] or {})}' \
	    > "$$SUMMARY"; \
	  echo "Wrote summary: $$SUMMARY"; \
	else \
	  echo "No built .sqlite to publish (all changed datasets under threshold). Skipping publish/sync."; \
	  SUMMARY="scripts/outputs/build_publish_sync_$$(date +%Y%m%d_%H%M%S).json"; \
	  STARTED=$$(date -Iseconds); \
	  FINISHED=$$(date -Iseconds); \
	  jq -n --arg version "$$VER" --arg started "$$STARTED" --arg finished "$$FINISHED" --arg changed "$$CHANGED" \
	    '{version:$$version, startedAt:$$started, finishedAt:$$finished, changed:($$changed|split(",")|map(select(length>0))), published:[], efsSync:{}}' \
	    > "$$SUMMARY"; \
	  echo "Wrote summary: $$SUMMARY"; \
	fi
