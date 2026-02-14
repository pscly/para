.PHONY: dev-up dev-down dev-reset

COMPOSE ?= docker compose
COMPOSE_FILE ?= docker-compose.yml

ENV_FILE := $(if $(wildcard .env),.env,.env.example)

dev-up:
	$(COMPOSE) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) up -d

dev-down:
	$(COMPOSE) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) down --remove-orphans

dev-reset:
	$(COMPOSE) --env-file $(ENV_FILE) -f $(COMPOSE_FILE) down -v --remove-orphans
