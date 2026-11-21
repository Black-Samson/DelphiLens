.PHONY: install setup check test dashboard worker cycle status digest feedback terms

install:
	npm install

setup: install
	@test -f .env || cp .env.example .env
	@echo "Edit .env, then run: make dashboard"

check:
	npm run check

test:
	npm test

dashboard:
	npm run dashboard

worker:
	npm run worker

cycle:
	npm start -- cycle

status:
	npm start -- status

digest:
	npm start -- digest

feedback:
	npm start -- feedback

terms:
	npm start -- terms
