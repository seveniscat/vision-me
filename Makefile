.PHONY: help install dev run backend frontend

SHELL := /bin/bash
.DEFAULT_GOAL := help

help:
	@echo "可用命令:"
	@echo "  make install   安装 backend 和 frontend 依赖"
	@echo "  make dev       同时启动后端和前端开发服务"
	@echo "  make run       make dev 的别名"
	@echo "  make backend   只启动后端开发服务"
	@echo "  make frontend  只启动前端开发服务"

install:
	@echo "Installing backend dependencies..."
	@cd backend && npm install
	@echo "Installing frontend dependencies..."
	@cd frontend && npm install

dev:
	@echo "Starting backend and frontend dev servers..."
	@set -euo pipefail; \
	(cd backend && npm run dev) & \
	backend_pid=$$!; \
	(cd frontend && npm run dev) & \
	frontend_pid=$$!; \
	cleanup() { \
		kill $$backend_pid $$frontend_pid 2>/dev/null || true; \
		wait $$backend_pid $$frontend_pid 2>/dev/null || true; \
	}; \
	trap cleanup INT TERM EXIT; \
	wait -n $$backend_pid $$frontend_pid; \
	status=$$?; \
	cleanup; \
	exit $$status

run: dev

backend:
	@cd backend && npm run dev

frontend:
	@cd frontend && npm run dev
