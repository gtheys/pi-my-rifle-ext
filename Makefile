# Format code
fmt:
	npm run format

# Check code for lint issues
lint:
	npm run lint

# Run tests
test:
	npm test

# Run all non-mutating checks
check:
	npm run check

# Release a new version
release:
	npm run release

# Run a dry-run release
release-dry-run:
	npm run release:dry-run

# Apply automatic fixes
fix:
	npm run lint:fix
	npm run format

# Show available targets
help:
	@echo ""
	@echo "  fmt              Format code (biome --write)"
	@echo "  lint             Check for lint issues (biome check)"
	@echo "  fix              Apply lint + format fixes"
	@echo "  test             Run tests across all workspaces"
	@echo "  check            lint + typecheck + test (full CI pass)"
	@echo "  release          Publish all packages to npm"
	@echo "  release-dry-run  Dry-run publish (shows tarball contents)"
	@echo "  help             Show this message"
	@echo ""

.PHONY: fmt lint test check release release-dry-run fix help
