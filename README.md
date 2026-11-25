# Stoic

Parses a spoken/typed food order into structured menu line items, using an LLM
hosted on [OpenAI](https://openai.com) for intent extraction and Fuse.js to snap the result onto the
real menu and supply catalog IDs.

## How to run

1. Clone this repo
2. Get an OpenAI API key from https://platform.openai.com/api-keys and put it in `.env`:

```bash
cp .env.example .env
# edit .env and set OPENAI_KEY=...
```

3. Install dependencies:

```bash
npm install
```

4. Start the server:

```bash
npm start
```

5. The API is ready:

```bash
curl -X POST http://localhost:3000/parse \
  -H "Content-Type: application/json" \
  -d '{"outletId": "1501", "text": "Give me 2 chees burgers and one crystal"}'
```

Response:

```json
{
  "items": [
    { "id": 37712, "name": "Cheese Burgers", "qty": 2, "score": 0.001 },
    { "id": 5, "name": "Crystal Cola", "qty": 1, "score": 0.32 }
  ]
}
```

`score` is the Fuse.js match distance — lower is a better match. Use it to
decide whether to confirm an item with the customer before adding it.

## Catalogs

Each outlet's menu lives in `catalogs/<outletId>.json`, and `/parse` uses the
file for the `outletId` in the request. (`catalogs/1501.json` holds the menu
that used to be hardcoded.) Create or refresh an outlet's catalog with:

```bash
curl -X POST http://localhost:3000/update-catalog \
  -H "Content-Type: application/json" \
  -d '{
    "outletId": "1501",
    "categoryListUrl": "https://.../categories",
    "categoryItemListUrl": "https://.../items",
    "authToken": "Bearer ..."
  }'
```

What it does:

1. GETs `categoryListUrl?size=50&page0=N` for N = 0, 1, … until the last page
   (`categoriesPaged.last` / `totalPages`), skipping inactive categories.
2. For each category, GETs `categoryItemListUrl?categoryId=<id>&size=20&page0=N`
   until that category's last page, then moves on to the next category.
3. Merges items by `id` (an item in several categories is stored once, with all
   its `categoryIds`), drops inactive ones, and writes the file atomically.

`authToken` is sent as-is in the `Authorization` header. If the upstream returns
no items, the existing file is left untouched. Only one update per outlet runs
at a time.

## Configuration

Config comes from the environment, or a `.env` file in the project root (loaded
automatically — no `dotenv` dependency). Copy `.env.example` to `.env` to start.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_KEY` | *(required)* | OpenAI API key |
| `OPENAI_MODEL` | `gpt-6.1-terra` | Model used for parsing |
| `OPENAI_REASONING_EFFORT` | `low` | Reasoning effort; ignored for GPT-4 and older |
| `OPENAI_URL` | `https://api.openai.com/v1` | OpenAI API endpoint |
| `PORT` | `3000` | Port the API listens on |
| `CATALOG_DIR` | `catalogs` | Where outlet catalog files are stored |

The default model supports OpenAI's structured outputs (`json_schema`). If
another model rejects `json_schema`, the server falls back to plain JSON mode.
GPT-4 and older are sent `temperature: 0`; newer models get `reasoning_effort`. List the models your key can use:

```bash
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_KEY"
```

Override per-run:

```bash
OPENAI_MODEL=gpt-6.2-sol npm start
```

## Notes

- Requires Node 18+ (uses the built-in `fetch`); developed on Node 24.
- Requires Node 20.6+ for automatic `.env` loading.
- `.env` holds your API key and is gitignored. Don't commit it.
- `/update-catalog` fetches whatever URLs it is given, so don't expose it to
  untrusted callers.
- The server binds `0.0.0.0` and has no authentication — it's meant for local
  development, not for exposing on a shared network as-is.
