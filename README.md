# Screenshot API (Fastify + Playwright + Cloudflare R2)

This service exposes two endpoints to generate web page screenshots and PDFs, then uploads the result to **Cloudflare R2** (S3-compatible) and returns a public URL.

## Endpoints

### `POST /screenshot`

Request body (JSON):
```json
{
  "url": "https://example.com"
}
```

Response (200):
```json
{
  "status": "success",
  "message": "Screenshot saved",
  "path": "https://<public-r2-base-url>/screenshot-<timestamp>.png"
}
```

### `POST /pdf`

Request body (JSON):
```json
{
  "url": "https://example.com"
}
```

Response (200):
```json
{
  "status": "success",
  "message": "PDF saved",
  "path": "https://<public-r2-base-url>/export-<timestamp>.pdf"
}
```

## Authentication (API Key)

Every request must include the header:

`x-api-key: <MASTER_API_KEY>`

If the key is missing or invalid, the API returns `401`.

Example with curl:
```bash
curl -X POST http://localhost:3000/screenshot \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-test-666" \
  -d '{"url":"https://example.com"}'
```

## Environment variables

The service reads configuration from environment variables (you can use `.env` locally).

- `MASTER_API_KEY`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

## Run locally

```bash
npm install
npm start
```

# my-screenshot-api
