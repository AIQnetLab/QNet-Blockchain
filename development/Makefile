# QNet Makefile
.PHONY: help install build test run clean docker-build docker-run format lint docs

# Default target
help:
	@echo "QNet Development Commands:"
	@echo "  make install      - Install all dependencies"
	@echo "  make build        - Build Rust and Go modules"
	@echo "  make test         - Run all tests"
	@echo "  make run          - Run a full node"
	@echo "  make clean        - Clean build artifacts"
	@echo "  make docker-build - Build Docker image"
	@echo "  make docker-run   - Run with Docker Compose"
	@echo "  make format       - Format code"
	@echo "  make lint         - Run linters"
	@echo "  make docs         - Build documentation"

# Install dependencies
install:
	@echo "Installing Python dependencies..."
	pip install -r requirements.txt
	pip install -r requirements-dev.txt
	@echo "Dependencies installed!"

# Build all modules
build: build-rust build-go
	@echo "Build complete!"

# Build Rust modules
build-rust:
	@echo "Building Rust modules..."
	cd qnet-core-rust && cargo build --release
	cd qnet-consensus-rust && cargo build --release

# Build Go network layer
build-go:
	@echo "Building Go network layer..."
	cd qnet-network && go build

# Run tests
test: test-python test-rust test-go
	@echo "All tests passed!"

# Python tests
test-python:
	@echo "Running Python tests..."
	pytest tests/ -v --cov=qnet_core --cov=qnet_node

# Rust tests
test-rust:
	@echo "Running Rust tests..."
	cd qnet-core-rust && cargo test
	cd qnet-consensus-rust && cargo test

# Go tests
test-go:
	@echo "Running Go tests..."
	cd qnet-network && go test ./...

# Run node
run:
	python qnet-node/src/node/node.py

# Run light node
run-light:
	NODE_TYPE=light python qnet-node/src/node/node.py

# Run super node
run-super:
	NODE_TYPE=super python qnet-node/src/node/node.py

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
	find . -type f -name "*.pyo" -delete
	find . -type f -name "*.so" -delete
	find . -type d -name "*.egg-info" -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -exec rm -rf {} +
	find . -type d -name ".coverage" -exec rm -rf {} +
	rm -rf build/ dist/
	cd qnet-core-rust && cargo clean
	cd qnet-consensus-rust && cargo clean
	cd qnet-network && go clean
	@echo "Clean complete!"

# Docker commands
docker-build:
	@echo "Building Docker image..."
	docker build -t qnet-node:latest .

docker-run:
	@echo "Starting QNet with Docker Compose..."
	docker-compose up -d

docker-stop:
	@echo "Stopping QNet containers..."
	docker-compose down

docker-logs:
	docker-compose logs -f qnet-node

# Code formatting
format: format-python format-rust format-go

format-python:
	@echo "Formatting Python code..."
	black qnet-core/ qnet-node/ qnet-sdk/ qnet-vm/
	isort qnet-core/ qnet-node/ qnet-sdk/ qnet-vm/

format-rust:
	@echo "Formatting Rust code..."
	cd qnet-core-rust && cargo fmt
	cd qnet-consensus-rust && cargo fmt

format-go:
	@echo "Formatting Go code..."
	cd qnet-network && go fmt ./...

# Linting
lint: lint-python lint-rust lint-go

lint-python:
	@echo "Linting Python code..."
	flake8 qnet-core/ qnet-node/ qnet-sdk/ qnet-vm/
	mypy qnet-core/ qnet-node/ qnet-sdk/ qnet-vm/

lint-rust:
	@echo "Linting Rust code..."
	cd qnet-core-rust && cargo clippy -- -D warnings
	cd qnet-consensus-rust && cargo clippy -- -D warnings

lint-go:
	@echo "Linting Go code..."
	cd qnet-network && golangci-lint run

# Documentation
docs:
	@echo "Building documentation..."
	cd qnet-docs && mkdocs build

docs-serve:
	@echo "Serving documentation..."
	cd qnet-docs && mkdocs serve

# Development setup
dev-setup:
	@echo "Setting up development environment..."
	python -m venv venv
	@echo "Virtual environment created. Activate with:"
	@echo "  source venv/bin/activate  # Linux/Mac"
	@echo "  venv\\Scripts\\activate   # Windows"

# Benchmarks
benchmark:
	@echo "Running benchmarks..."
	cd qnet-core-rust && cargo bench
	cd qnet-consensus-rust && cargo bench
	pytest tests/benchmarks/ -v

# Security scan
security:
	@echo "Running security scan..."
	bandit -r qnet-core/ qnet-node/ qnet-sdk/ qnet-vm/
	safety check

# Release
release:
	@echo "Preparing release..."
	python -m build
	twine check dist/*

# Quick start
quickstart:
	python quickstart.py 