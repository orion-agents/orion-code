# Contributing to Orion Code

Thank you for your interest in contributing to Orion Code! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/Linux2010/orion-code.git
cd orion-code

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## Project Structure

```
orion-code/
├── src/
│   ├── cli.ts           # CLI entry point
│   ├── commands/        # Slash commands
│   ├── core/            # Core agent framework
│   ├── framework/       # Query loop, tools framework
│   ├── harness/         # Safety harness
│   ├── memory/          # Memory system
│   ├── services/        # LLM, config, session services
│   ├── tools/           # Tool implementations
│   └── ui/              # UI components (command panel, etc.)
├── tests/               # Test files
├── docs/                # Documentation
└── .github/             # GitHub templates
```

## Coding Guidelines

### Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Add JSDoc comments for public APIs
- Keep functions small and focused

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix a bug
docs: update documentation
test: add tests
refactor: code refactoring
chore: maintenance tasks
```

### Testing

- Write tests for new features
- Ensure all tests pass before submitting PR
- Aim for > 70% test coverage

## Pull Request Process

1. Create a branch from `main`
2. Make your changes
3. Run tests: `npm test`
4. Build: `npm run build`
5. Submit PR with clear description
6. Address review feedback

## Issue Reporting

Use GitHub issue templates:
- Bug report: Describe the bug with reproduction steps
- Feature request: Describe the desired functionality

## Code of Conduct

Be respectful and constructive. We welcome contributions from everyone.

---

Thank you for contributing! 🐴