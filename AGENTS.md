# AGENTS.md

## Cursor Cloud specific instructions

Vision-Me is a two-package Node.js/TypeScript repo:

- `backend/` — Express API + CLI two-stage text-detection pipeline (port `3001`). Calls Qwen VL-Max via Aliyun DashScope.
- `frontend/` — React + Ant Design + Vite UI (dev port `5173`), proxies `/api` to the backend.

Standard commands live in each package's `package.json` (`dev`, `build`, `typecheck`, and `detect` for the backend CLI) and in `README.md`. There are no automated tests and no linter; `npm run typecheck` (tsc) is the closest static check.

Non-obvious caveats:

- The dev environment refresh (`npm install` in both packages) is handled by the startup update script; you do not need to reinstall manually.
- `backend/.env` is required and git-ignored. Create it once with `cp backend/.env.example backend/.env`. The server, `typecheck`, and `build` all work without a real key; only actual detection needs it.
- **Real detection requires a valid `DASHSCOPE_API_KEY`** (paid Aliyun DashScope / 百炼 service). Without it, the pipeline starts (tiling progress streams over SSE) and then fails at the first Qwen call with `缺少 DASHSCOPE_API_KEY 环境变量`. Prefer setting it via a Cursor secret rather than committing it to `.env`.
- The product can be exercised two ways: the web UI (`backend dev` + `frontend dev`) or the backend CLI (`npm run detect /path/to/image.jpg`). Both hit the same external API.
- Backend uses `tsx watch`; it hot-reloads on source changes. Frontend is Vite with HMR.
- Health check: `GET http://localhost:3001/health`; config echo: `GET http://localhost:3001/api/info`.
