PORT ?= 8080

.PHONY: run build test stop

node_modules: package.json package-lock.json
	npm install
	@touch node_modules

build: node_modules

test: build
	npm test

run: build
	PORT=$(PORT) npm start

stop:
	-pkill -f "node server/index.js"
