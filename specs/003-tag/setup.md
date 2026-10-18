# Tag Endpoint: Setup & Usage

## 1. Get a TypeSafe API key

1. Go to [console.typesafe.ai/keys](https://console.typesafe.ai/keys)
2. Create a new API key
3. Copy the key value

## 2. Configure the environment variable

### Local development

Add to your `.env` file in `wrait-backend/`:

```
TYPESAFE_API_KEY=your-api-key-here
```

### Vercel deployment

Add the environment variable in the Vercel dashboard:

1. Go to your project settings on [vercel.com](https://vercel.com)
2. Navigate to **Settings > Environment Variables**
3. Add `TYPESAFE_API_KEY` with your API key
4. Select the environments where it should be available (Production, Preview, Development)
5. Save

### Android app (`local.properties`)

No changes needed on the Android side for the API key — it lives only on the backend. The app calls the backend, which calls TypeSafe.

## 3. Run the migration

If deploying to a new environment where the database hasn't been migrated yet:

```bash
npx prisma migrate deploy
```

This adds the `TAG` value to the `CallCountType` enum.

## 4. API usage

### Request

```bash
curl -X POST https://your-backend-url/api/tag \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Secret: YOUR_PROXY_SECRET" \
  -H "X-Device-Id: YOUR_64_CHAR_HEX_DEVICE_ID" \
  -d '{
    "text": "Today I went for a long run in the park and felt great afterwards.",
    "tags": ["exercise", "nature", "mood", "work", "food", "travel"]
  }'
```

### Response

```json
{
  "tags": [
    { "tag": "exercise", "probability": 0.72 },
    { "tag": "mood", "probability": 0.55 },
    { "tag": "nature", "probability": 0.41 },
    { "tag": "food", "probability": 0.03 },
    { "tag": "work", "probability": 0.02 },
    { "tag": "travel", "probability": 0.01 }
  ]
}
```

Tags are sorted by descending probability. Each probability is a number between 0 and 1.

### Constraints

| Field  | Rule                                                  |
| ------ | ----------------------------------------------------- |
| `text` | Non-empty string, max 10,000 characters               |
| `tags` | Array of 2–50 unique non-empty strings                |
| Body   | Max 256 KiB                                           |

### Error codes

| Status | Meaning                          |
| ------ | -------------------------------- |
| 400    | Invalid input                    |
| 401    | Wrong or missing proxy secret    |
| 405    | Not a POST request               |
| 413    | Request body too large           |
| 429    | Daily quota exceeded             |
| 500    | Missing `TYPESAFE_API_KEY`       |
| 502    | TypeSafe API error               |
| 504    | TypeSafe API timeout (15s)       |

## 5. Quick test with the script

```bash
PROXY_SECRET=your-secret ./vercel-api.sh
```

The script includes a tag endpoint test (test #5).

## 6. Android integration notes

To use from the Android app, send the same request the app already uses for cleanup/transcribe — same `X-Proxy-Secret` and `X-Device-Id` headers — with the JSON body containing `text` and `tags`. Apply a local threshold (e.g., probability > 0.3) to decide which tags to assign to an entry. The backend does not store any text, tags, or results.
