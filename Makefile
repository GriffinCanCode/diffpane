.PHONY: build test install lint-doc-radar
build:
	npm run build
test:
	npm test
install:
	npm run install:app
lint-doc-radar:
	npm run test:docs
