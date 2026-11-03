# HTTP API

All `/api` routes use JSON and, except health/session/setup/login, require the `nw_session` HttpOnly cookie.

- Authentication: `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`.
- Projects: `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, plus `duplicate`, `archive`, and `restore` actions.
- State: `GET/PUT /api/projects/:id/state` and `GET/PUT /api/projects/:id/chapters/:chapter`.
- Story bible: CRUD under `/api/projects/:id/characters`, `/locations`, and `/relations`.
- Migration/export: `POST /api/import/legacy-browser`, `GET /api/projects/:id/export`.
- Global configuration: `GET/PUT /api/settings`; authenticated clients use `GET /api/settings/runtime` when real API keys are required.

Mutating project requests carry the last known `revision`. A stale revision returns `409` with `currentRevision`; clients must not retry blindly.
