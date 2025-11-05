import express from "express";
import fetch from "node-fetch";
import Fuse from "fuse.js";

const app = express();
app.use(express.json());

// Hardcoded menu (later load from DB)
const menu = [
  { id: 1, name: "Cheeseburger" },
  { id: 2, name: "French Fries - Large" },
  { id: 3, name: "Coke" },
  { id: 4, name: "Chicken Mayo Deluxe" },
  { id: 5, name: "Crystal Cola" },
];

// Fuzzy matcher
const fuse = new Fuse(menu, { keys: ["name"], threshold: 0.3 });

async function askLLM(prompt) {
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral",
      prompt,
      stream: false,
    }),
  });

  const data = await response.json();
  return data.response;
}

app.post("/parse", async (req, res) => {
  const text = req.body.text;

  const prompt = `
  Extract food/drink items with their quantities.
  Return ONLY valid JSON array. NO explanation.
  Format example:
  [
    { "raw": "Cheeseburger", "qty": 2 },
    { "raw": "Coke", "qty": 1 }
  ]
  
  If quantity missing, set qty = 1.
  
  User text: "${text}"
  `;

  const raw = await askLLM(prompt);

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log("LLM returned:", raw);
    return res.status(400).json({ error: "LLM returned invalid JSON" });
  }

  // ✅ Ensure it's always an array
  if (!Array.isArray(parsed)) {
    return res.status(400).json({ error: "Expected JSON array", raw });
  }

  // ✅ Fuzzy match each item
  const result = parsed.map((item) => {
    const name = item.raw ?? item.name ?? "";
    const qty = item.qty ?? 1;

    if (!name || typeof name !== "string") {
      return { id: null, name, qty, warning: "Invalid item name" };
    }

    const match = fuse.search(name)[0];

    return match
      ? { id: match.item.id, name: match.item.name, qty }
      : { id: null, name, qty, warning: "not in menu" };
  });

  res.json({ items: result });
});

app.listen(3000, () => console.log("Server running on 3000"));
