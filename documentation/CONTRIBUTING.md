# Contributing to QNet

Thank you for your interest in contributing to QNet! This document provides guidelines and instructions for contributing to the project.

## 🤝 Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct:
- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive criticism
- Respect differing viewpoints and experiences

## 🚀 Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/qnet-project.git
   cd qnet-project
   ```
3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/qnet-project/qnet-project.git
   ```
4. **Create a branch** for your feature:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## 📋 Development Process

### 1. Before You Start
- Check existing issues and PRs to avoid duplicating work
- For major changes, open an issue first to discuss
- Ensure your development environment is set up correctly

### 2. Development Setup

**Python Environment:**
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
pip install -r requirements-dev.txt
```

**Rust Environment:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable
rustup component add clippy rustfmt
```

**Go Environment:**
```bash
# Install Go 1.20+ from https://golang.org/dl/
go version  # Verify installation
```

### 3. Code Style

**Python:**
- Follow PEP 8
- Use type hints where possible
- Maximum line length: 100 characters
- Run before committing:
  ```bash
  black qnet-core/ qnet-node/
  flake8 qnet-core/ qnet-node/
  mypy qnet-core/ qnet-node/
  ```

**Rust:**
- Follow standard Rust conventions
- Run before committing:
  ```bash
  cargo fmt --all
  cargo clippy --all-targets --all-features -- -D warnings
  ```

**Go:**
- Follow standard Go conventions
- Run before committing:
  ```bash
  go fmt ./...
  go vet ./...
  golint ./...
  ```

### 4. Testing

**Python Tests:**
```bash
pytest tests/
pytest tests/ --cov=qnet_core --cov-report=html
```

**Rust Tests:**
```bash
cargo test --all
cargo test --all --release  # Performance tests
```

**Go Tests:**
```bash
go test ./...
go test -race ./...  # Race condition detection
```

### 5. Documentation

- Update relevant documentation for your changes
- Add docstrings to new functions/classes
- Update README.md if adding new features
- Include examples for new functionality

## 🔄 Pull Request Process

1. **Update your branch** with latest upstream changes:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run all tests** and ensure they pass

3. **Commit your changes** with clear messages:
   ```bash
   git commit -m "feat: add new consensus algorithm"
   ```
   
   Commit message format:
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation changes
   - `test:` Test additions/changes
   - `refactor:` Code refactoring
   - `perf:` Performance improvements
   - `chore:` Maintenance tasks

4. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

5. **Create Pull Request** on GitHub:
   - Use a clear, descriptive title
   - Reference any related issues
   - Describe what changes you made and why
   - Include screenshots for UI changes

6. **Address review feedback** promptly

## 🏗️ Architecture Guidelines

### Module Structure
- Keep modules focused and single-purpose
- Use clear, descriptive names
- Maintain backward compatibility when possible

### Performance Considerations
- Profile before optimizing
- Document performance-critical code
- Consider mobile constraints

### Security Guidelines
- Never commit secrets or private keys
- Validate all inputs
- Use secure random number generation
- Follow OWASP guidelines

## 🐛 Reporting Issues

When reporting issues, please include:
- QNet version
- Operating system and version
- Steps to reproduce
- Expected vs actual behavior
- Error messages and logs
- Screenshots if applicable

## 💡 Feature Requests

We welcome feature requests! Please:
- Check if already requested
- Provide clear use cases
- Explain why it benefits QNet
- Consider implementation complexity

## 📚 Resources

- [QNet Documentation](https://docs.qnet.network)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [API Reference](docs/API.md)
- [Discord Community](https://discord.gg/qnet)

## 🎯 Priority Areas

Current areas where we especially welcome contributions:
- Mobile wallet development
- Smart contract templates
- Performance optimizations
- Documentation improvements
- Test coverage expansion
- Cross-chain bridge implementations

## 📜 License

By contributing to QNet, you agree that your contributions will be licensed under the MIT License.

## 🙏 Recognition

Contributors will be recognized in:
- CONTRIBUTORS.md file
- Release notes
- Project website

Thank you for helping make QNet better! 🚀 