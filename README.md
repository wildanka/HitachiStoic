# Stoic

Parses a spoken/typed food order into structured menu line items, using a local
LLM (via Ollama) for intent extraction and Fuse.js to snap the result onto the
real menu and supply catalog IDs.

## How to run

1. Clone this repo
2. Install [Ollama](https://ollama.com) on your machine
3. Pull the model:

```bash
ollama pull qwen3:4b
```

4. Make sure Ollama is running (`ollama serve`, or the desktop app) — or skip
   steps 2–4 entirely and use the hosted service, see [Configuration](#configuration)
5. Install dependencies:

```bash
npm install
```

6. Start the server:

```bash
npm start
```

7. The API is ready:

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

The app runs in one of two modes, chosen by whether `OLLAMA_API_KEY` is set:

| Variable | Hosted default | Local default | Purpose |
| --- | --- | --- | --- |
| `OLLAMA_API_KEY` | *(you set it)* | unset | Enables hosted mode |
| `OLLAMA_URL` | `https://ollama.com` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `gpt-oss:120b-cloud` | `qwen3:4b` | Model used for parsing |
| `PORT` | `3000` | `3000` | Port the API listens on |

### Hosted (no local Ollama needed)

Get a key from https://ollama.com/settings/keys, then:

```bash
cp .env.example .env
# edit .env and set OLLAMA_API_KEY=...
npm start
```

Hosted model names carry a `-cloud` suffix. List what your key can reach:

```bash
curl -s https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY"
```

### Local

Leave `OLLAMA_API_KEY` unset and run Ollama yourself:

```bash
ollama pull qwen3:4b
npm start
```

Either mode can be overridden per-run:

```bash
OLLAMA_MODEL=mistral:latest npm start
```

## Notes

- Requires Node 18+ (uses the built-in `fetch`); developed on Node 24.
- `.env` holds your API key and is gitignored. Don't commit it.
- The server binds `0.0.0.0` and has no authentication — it's meant for local
  development, not for exposing on a shared network as-is.
