# Web — Coding Rules

This is the web layer of an EdgeSpark project. It's a React SPA served via Cloudflare Workers Static Assets.

## Architecture

- **Framework**: React + Vite
- **Hosting**: Cloudflare Workers Static Assets (edge CDN, zero worker CPU)
- **Routing**: SPA fallback — all non-file paths serve `index.html`
- **API**: `@edgespark/web` initialized in `src/lib/edgespark.ts` (auth + API with cookie credentials)

## SDK Types

Read `node_modules/@edgespark/web/dist/index.d.ts` for the full API surface and JSDoc.

## API Conventions

- `GET /api/public/*` — Public endpoints (no auth required)
- `GET /api/*` — Protected endpoints (login required)
- `POST /api/webhooks/*` — Webhook endpoints (no auth)

All API calls go through the same origin — no CORS issues in production.

## Development

```bash
npm run dev     # Start Vite dev server (proxies /api to localhost:8787)
npm run build   # Build for production (outputs to dist/)
```

## Project Structure

```
src/
├── App.tsx            # Main application component — start here
├── main.tsx           # Entry point (do not modify)
├── index.css          # Global styles and Tailwind CSS import
├── components/        # Reusable UI components
├── pages/             # Page-level components (one per route)
├── layouts/           # Layout wrappers (nav, sidebar, footer)
├── hooks/             # Custom React hooks
├── lib/               # Utilities and helpers
└── types/             # TypeScript type definitions
```

Create directories as needed — keep components small and focused.

## Build Output

Build output directory defaults to `dist/`. If you change the build tool or output directory, update `[app.web].output_path` in `edgespark.toml` to match.

## Rules

1. Use `client.api.fetch('/api/...')` from `src/lib/edgespark.ts` for API calls — cookie credentials are automatic
2. Use `@edgespark/web` for all browser auth flows
3. Prefer `client.authUI.mount()` for managed auth UI
4. For custom auth flows, use `client.auth` directly — it has a Better Auth-compatible shape with EdgeSpark additions
5. Do not implement app auth by calling `/api/_es/auth/*` endpoints manually — those are for platform debugging and verification, not normal app code
6. Don't import from `../server/` directly
7. Keep the bundle small — lazy-load routes and heavy components
8. Handle loading and error states for all API calls
9. If you change the build tool or output directory, update `[app.web].output_path` in `edgespark.toml`
