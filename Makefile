.PHONY: setup dev build test install verify lint-doc-radar
setup:
	npm ci
dev:
	npm run dev -- .
build:
	npm run build
test:
	npm test
install:
	npm run install:app
verify:
	npm run verify
lint-doc-radar:
	npm run test:docs
