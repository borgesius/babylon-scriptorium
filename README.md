# Basic Template

A modern TypeScript project template for Node.js applications.

## Features

- **TypeScript** - Strict type checking with ES2022 target
- **tsx** - Fast TypeScript execution with watch mode
- **Vitest** - Fast unit testing framework
- **ESLint** - Code linting with TypeScript support
- **Prettier** - Code formatting
- **Commitlint** - Conventional commit message enforcement
- **Semantic Release** - Automated versioning and changelog generation
- **GitHub Actions** - CI/CD workflows for PRs and releases

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
npm install
```

### Development

Run in watch mode (auto-reloads on changes):

```bash
npm run dev
```

### Building

Build for production:

```bash
npm run build
```

Run the built output:

```bash
npm start
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with watch mode |
| `npm run build` | Build for production |
| `npm start` | Run built output |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix linting issues |
| `npm run format` | Format code with Prettier |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test` | Run tests in watch mode |
| `npm run test:unit` | Run all tests once |
| `npm run test:coverage` | Run tests with coverage |

## Project Structure

```
src/
├── __tests__/       # Test files
├── core/            # Core utilities
│   └── Logger.ts
└── main.ts          # Application entry point
```

## Logging

This template includes a debug-based logging utility. Enable it via environment variable:

```bash
DEBUG=app:* npm run dev
```

Or enable specific namespaces:

```bash
DEBUG=app:api,app:db npm run dev
```

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are validated on PR.

Format: `<type>(<scope>): <subject>`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`

Examples:
- `feat(api): add rate limiting`
- `fix(db): resolve connection leak`

## License

MIT
