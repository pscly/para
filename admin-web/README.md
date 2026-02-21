# para admin-web

Admin console (Vite + React + TypeScript) for managing feature flags, audit logs, reviews, and invites.

For the authoritative runbook and production deployment notes, see:

- `docs/runbook.md`
- `docs/admin-web-deploy.md`
- `deploy/prod/README.md`

## Prerequisites

- Node.js (recommended: Node 20)
- A running `para` backend (local or remote)

## Development

```bash
npm -C admin-web install
VITE_SERVER_BASE_URL=http://127.0.0.1:8000 npm -C admin-web run dev
```

## Build

```bash
npm -C admin-web run build
```

Output: `admin-web/dist/`

## E2E

The web-admin E2E tests live under `client/playwright/` and are run from `client/`:

```bash
npm -C client run e2e -- playwright/web-admin-feature-flags.spec.ts playwright/web-admin-invites.spec.ts
```
