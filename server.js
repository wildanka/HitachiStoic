import express from "express";
import { CatalogError, getCatalog, normalizeOutletId, updateCatalog } from "./catalog.js";

const app = express();
app.use(express.json());

// Reads .env if present. Built into Node 20.6+, so no dotenv dependency.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file - rely on the ambient environment
}

const PORT = Number(process.env.PORT ?? 3000);

// OpenAI API. Get a key at https://platform.openai.com/api-keys
const API_KEY = process.env.OPENAI_KEY?.trim() || null;

const OPENAI_URL = (process.env.OPENAI_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");

const MODEL = process.env.OPENAI_MODEL ?? "gpt-6.1-terra";

// Reasoning models (gpt-5 and later, o-series) take reasoning_effort and may
// reject temperature; older models are the other way round.
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT?.trim() || "low";
const SAMPLING = /^gpt-[34]/.test(MODEL)
  ? { temperature: 0 }
  : { reasoning_effort: REASONING_EFFORT };

if (!API_KEY) {
  console.error("OPENAI_KEY is not set. Add it to .env (see .env.example).");
  process.exit(1);
}

// Shape we want back from the model. OpenAI's structured outputs need an object
// at the root, so the order lines live under "items".
const ORDER_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw: { type: "string" },
          qty: { type: "integer" }
        },
        required: ["raw", "qty"],
        additionalProperties: false
      }
    }
  },
  required: ["items"],
  additionalProperties: false
};

async function callOpenAI(body) {
  try {
    return await fetch(`${OPENAI_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`cannot reach OpenAI at ${OPENAI_URL}: ${e.message}`);
  }
}

async function askLLM(prompt) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    ...SAMPLING,
    response_format: {
      type: "json_schema",
      json_schema: { name: "order", strict: true, schema: ORDER_SCHEMA },
    },
  };

  let response = await callOpenAI(body);

  // Not every OpenAI model supports json_schema. Fall back to plain JSON mode,
  // which they all accept, rather than surfacing a confusing 400.
  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (/response_format|json_schema/i.test(detail)) {
      response = await callOpenAI({ ...body, response_format: { type: "json_object" } });
    } else {
      throw new Error(`OpenAI returned 400: ${detail.slice(0, 300)}`);
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`OpenAI rejected the credentials (${response.status}). Check OPENAI_KEY.`);
  }

  if (response.status === 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Model "${MODEL}" not found on OpenAI. ${detail.slice(0, 200)}`);
  }

  if (response.status === 429) {
    // OpenAI also uses 429 for an exhausted credit balance, so keep the detail.
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI rate limit or quota hit (429): ${detail.slice(0, 300)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI returned ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();

  return data.choices?.[0]?.message?.content ?? "";
}

// Models still occasionally wrap output in fences or a think block even with
// structured output on, so unwrap defensively before parsing.
function extractJsonArray(raw) {
  if (typeof raw !== "string") return null;

  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();

  try {
    const parsed = JSON.parse(s);
    // Structured output wraps the list as { items: [...] }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.items)) return parsed.items;
    return parsed;
  } catch {
    // fall through
  }

  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

function normalizeQty(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 99);
}

function sendError(res, e, fallbackStatus = 500) {
  const status = e instanceof CatalogError ? e.status : fallbackStatus;
  if (status >= 500) console.error(e.message);
  return res.status(status).json({ error: e.message });
}

// Pulls every category (all pages), then every item of every category (all
// pages), and saves the result as catalogs/<outletId>.json.
app.post("/update-catalog", async (req, res) => {
  try {
    const outletId = normalizeOutletId(req.body?.outletId);
    const result = await updateCatalog(outletId, req.body);
    console.log(`Catalog updated for outlet ${outletId}: ${result.itemCount} items`);
    res.json(result);
  } catch (e) {
    sendError(res, e);
  }
});

app.post("/parse", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

  if (!text) {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string" });
  }

  let catalog;
  try {
    catalog = await getCatalog(normalizeOutletId(req.body?.outletId));
  } catch (e) {
    return sendError(res, e);
  }
  const { menuList, fuse } = catalog;

  const prompt = `
You are a food order parser for an Indonesian outlet. The order below is automatic speech recognition (ASR) output from an Indonesian speaker. Menu names may be English, Japanese, French or Indonesian, spoken with an Indonesian accent, and the ASR often mishears them as unrelated words that merely SOUND similar.

MENU:
${menuList}

Rules:
- Return ONLY valid JSON, no explanation
- Format: { "items": [{ "raw": "<exact menu name>", "qty": <number> }] }
- Indonesian order structure: "<item> <number>" or "<number> <item>", joined by "sama", "dan", "terus", "tambah". The suffix "-nya" is a particle. A segment paired with a number is usually an order line.
- For each order line, if the words are not a menu name, read them aloud and compare the SOUND, syllable by syllable, with the menu names. Choose the menu item that sounds closest.
- Words may be partially lost: the line may contain only the sound of the first part of a menu name.
- Drinks: "es teh"/"teh" means tea; prefer the plain item when no variant is said.
- A clearly heard, real product that is not on the menu must be omitted, not substituted.
- Ignore table numbers, greetings, thanks and small talk ("oke", "ditunggu sebentar", "terima kasih").
- If quantity missing, set qty = 1
- Only use names that appear verbatim in the MENU above
- If nothing on the menu matches, return { "items": [] }

User order: "${text}"
`;

  let raw;
  try {
    raw = await askLLM(prompt);
  } catch (e) {
    console.error("LLM call failed:", e.message);
    return res.status(502).json({ error: "LLM unavailable", detail: e.message });
  }

  const parsed = extractJsonArray(raw);

  if (parsed === null) {
    console.log("LLM returned:", raw);
    return res.status(502).json({ error: "LLM returned invalid JSON", raw });
  }

  if (!Array.isArray(parsed)) {
    return res.status(502).json({ error: "Expected JSON array", raw });
  }

  // Fuzzy match each item back onto the real menu
  const items = parsed.map((item) => {
    const name = item?.raw ?? item?.name ?? "";
    const qty = normalizeQty(item?.qty);

    if (!name || typeof name !== "string") {
      return { id: null, name: String(name), qty, warning: "Invalid item name" };
    }

    const match = fuse.search(name)[0];

    return match
      ? { id: match.item.id, name: match.item.name, qty, score: match.score }
      : { id: null, name, qty, warning: "not in menu" };
  });

  res.json({ items });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT} (model: ${MODEL}, openai: ${OPENAI_URL})`);
});
