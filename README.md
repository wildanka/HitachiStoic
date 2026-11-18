# Stoic

Parses a spoken/typed food order into structured menu line items, using an LLM
hosted on [Groq](https://groq.com) for intent extraction and Fuse.js to snap the result onto the
real menu and supply catalog IDs.

## How to run

1. Clone this repo
2. Get a Groq API key from https://console.groq.com/keys and put it in `.env`:

```bash
cp .env.example .env
# edit .env and set GROQ_API_KEY=...
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
  -d '{"text": "Give me 2 chees burgers and one crystal"}'
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

## Configuration

Config comes from the environment, or a `.env` file in the project root (loaded
automatically — no `dotenv` dependency). Copy `.env.example` to `.env` to start.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | *(required)* | Groq API key |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | Model used for parsing |
| `GROQ_URL` | `https://api.groq.com/openai/v1` | Groq OpenAI-compatible endpoint |
| `PORT` | `3000` | Port the API listens on |

The default model supports Groq's structured outputs (`json_schema`). Other
models are fine too; if one rejects `json_schema` the server falls back to
plain JSON mode. List the models your key can use:

```bash
curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
```

Override per-run:

```bash
GROQ_MODEL=llama-3.3-70b-versatile npm start
```

## Notes

- Requires Node 18+ (uses the built-in `fetch`); developed on Node 24.
- Requires Node 20.6+ for automatic `.env` loading.
- `.env` holds your API key and is gitignored. Don't commit it.
- The server binds `0.0.0.0` and has no authentication — it's meant for local
  development, not for exposing on a shared network as-is.
