# Contributing

Thanks for considering a contribution to wrait-backend.

## Development Setup

Requires Node.js 20+.

```sh
npm install
```

`npm install` runs a `postinstall` step that generates the Prisma client and the
OpenAPI types, so no extra generation step is needed.

Copy the environment template and fill in local values:

```sh
cp .env.example .env
```

## Checks before a pull request

Run all three and make sure they pass:

```sh
npm run type-check
npm run lint
npm run test
```

There is no `build` script — `npm run type-check` (`tsc --noEmit`) is the
compile check.

## Pull Requests

- Keep changes focused.
- Include tests for behavior changes.
- Do not commit secrets, `.env`, or local build output.
- Use conventional commit-style titles where practical, for example
  `fix(transcribe): handle empty audio upload`.

## Reporting Issues

When reporting a bug, include:

- the affected endpoint and request shape
- expected behavior
- actual behavior
- reproduction steps
- relevant logs, with any secrets or personal data removed

Please report security or privacy issues privately — see
[SECURITY.md](SECURITY.md).
