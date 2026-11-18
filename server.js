import express from "express";
import Fuse from "fuse.js";

const app = express();
app.use(express.json());

// Reads .env if present. Built into Node 20.6+, so no dotenv dependency.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file - rely on the ambient environment
}

const PORT = Number(process.env.PORT ?? 3000);

// Groq's OpenAI-compatible API. Get a key at https://console.groq.com/keys
const API_KEY = process.env.GROQ_API_KEY?.trim() || null;

const GROQ_URL = (process.env.GROQ_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

if (!API_KEY) {
  console.error("GROQ_API_KEY is not set. Add it to .env (see .env.example).");
  process.exit(1);
}

// Menu (later load from DB). Source: merchant 1501 item export.
const menu = [
  { id: 84663, name: "Triple Cheese Burgers" },
  { id: 84662, name: "French Fries" },
  { id: 84661, name: "Fish Fillet Burgers" },
  { id: 84660, name: "Fanta" },
  { id: 84659, name: "Double Choco Sundae" },
  { id: 84658, name: "Double Cheese Burgers" },
  { id: 84657, name: "Diet Coke" },
  { id: 84656, name: "Coca Cola" },
  { id: 84655, name: "Choco Sundae" },
  { id: 84654, name: "Chicken Wrap" },
  { id: 84653, name: "Chicken Muffin with Egg" },
  { id: 84652, name: "Chicken Burgers Deluxe" },
  { id: 84651, name: "Chicken Burgers" },
  { id: 84650, name: "Chicken Muffin" },
  { id: 84649, name: "Cheese Croissants" },
  { id: 84648, name: "Butter Croissants" },
  { id: 84647, name: "Breakfast Wrap" },
  { id: 84646, name: "Big Breakfast" },
  { id: 84645, name: "BigMac Burgers" },
  { id: 84644, name: "Beef Burgers Deluxe" },
  { id: 84643, name: "Beef Burgers" },
  { id: 84642, name: "Banana Muffin" },
  { id: 84641, name: "Apple Pie" }
];

const menuList = menu.map(m => `- ${m.name}`).join("\n");

// Fuzzy matcher
const fuse = new Fuse(menu, { keys: ["name"], threshold: 0.5, includeScore: true });

// Shape we want back from the model. Groq's structured outputs need an object
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

async function callGroq(body) {
  try {
    return await fetch(`${GROQ_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`cannot reach Groq at ${GROQ_URL}: ${e.message}`);
  }
}

async function askLLM(prompt) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: "order", schema: ORDER_SCHEMA },
    },
  };

  let response = await callGroq(body);

  // Not every Groq model supports json_schema. Fall back to plain JSON mode,
  // which they all accept, rather than surfacing a confusing 400.
  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (/response_format|json_schema/i.test(detail)) {
      response = await callGroq({ ...body, response_format: { type: "json_object" } });
    } else {
      throw new Error(`Groq returned 400: ${detail.slice(0, 300)}`);
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Groq rejected the credentials (${response.status}). Check GROQ_API_KEY.`);
  }

  if (response.status === 404) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Model "${MODEL}" not found on Groq. ${detail.slice(0, 200)}`);
  }

  if (response.status === 429) {
    throw new Error("Groq rate limit hit (429). Slow down or upgrade the plan.");
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Groq returned ${response.status}: ${detail.slice(0, 300)}`);
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

app.post("/parse", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";

  if (!text) {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string" });
  }

  const prompt = `
You are a food order parser. Match user's spoken order to the closest item from this menu:

MENU:
${menuList}

Rules:
- Return ONLY valid JSON, no explanation
- Match to the closest menu item name even if the user mispronounces it
- Format: { "items": [{ "raw": "<exact menu name>", "qty": <number> }] }
- If quantity missing, set qty = 1
- Only use names that appear verbatim in the MENU above
- If the user asks for something that is not on the menu, omit it entirely
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
  console.log(`Server running on ${PORT} (model: ${MODEL}, groq: ${GROQ_URL})`);
});
