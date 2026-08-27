# RAG ChatBot Frontend

Static frontend for the RAG ChatBot application.

## Development

Install the development tools with `npm install`, then run:

```bash
npm run check
```

The UI expects these same-origin endpoints when served by the production backend:

- `GET /health`
- `GET /documents`
- `POST /upload` with multipart field `file`
- `GET /document/:id`
- `DELETE /document/:id`
- `GET /chat?question=...&documentId=...` returning SSE

For a separate local backend, set `window.RAG_API_BASE` before loading `app.js`, or use the built-in `localhost:3001` fallback.

## Production backend requirements

Conversation history is persisted server-side in PostgreSQL and scoped to a
signed HttpOnly browser session cookie. This is browser-session protection, not
user authentication; add an identity provider and per-user ownership before
exposing the service to multiple users.

The browser checks file extension, size, and empty files for user feedback only. The backend must independently enforce authentication, authorization, per-user document ownership, request limits, MIME/content inspection, malware scanning, filename normalization, rate limits, CORS/CSRF policy, and persistence.

The backend should emit valid SSE events with JSON payloads such as `{ "type": "status", "message": "..." }`, `{ "type": "token", "content": "..." }`, `{ "type": "sources", "documents": ["..."] }`, and `{ "type": "error", "message": "..." }`, followed by `data: [DONE]`.
