PORT ?= 8080
IMAGE ?= bubthegreat/pea-shooter

.PHONY: run build test stop docker-build docker-run

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

docker-build:
	docker build -t $(IMAGE):dev .

docker-run: docker-build
	docker run --rm -p $(PORT):8080 $(IMAGE):dev
