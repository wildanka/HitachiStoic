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
  { id: 37708, name: "Burgers Big Mac Double" },
  { id: 37711, name: "Burgers Big Mac" },
  { id: 37712, name: "Cheese Burgers" },
  { id: 37713, name: "Double Cheeseburgers" },
  { id: 37714, name: "Lemonade" },
  { id: 37715, name: "Coca cola" },
  { id: 37716, name: "Dr. Pepper" },
  { id: 37717, name: "Hot Tea" },
  { id: 37718, name: "Diet Coke" },
  { id: 37719, name: "French Fries" },
  { id: 37720, name: "Raspberry Pie" },
  { id: 37721, name: "Sausage Burrito" },
  { id: 37722, name: "Oreo McFlurry" },
  { id: 37723, name: "Strawberry Shake" },
  { id: 37724, name: "Vanilla Shake" },
  { id: 37725, name: "Egg and Cheese Bagel" },
  { id: 37726, name: "McDouble Burgers" },
  { id: 37727, name: "Quarter Pounder with Cheese" },
  { id: 37728, name: "Double Quarter Pounder with Cheese" }
];

const menuList = menu.map(m => `- ${m.name}`).join("\n");

// Fuzzy matcher
const fuse = new Fuse(menu, { keys: ["name"], threshold: 0.5 });

async function askLLM(prompt) {
  const response = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen2.5:3b",
      prompt,
      stream: false,
    }),
  });

  const data = await response.json();
  return data.response;
}

app.post("/parse", async (req, res) => {
  const text = req.body.text;

  // const prompt = `
  // Extract food/drink items with their quantities.
  // Return ONLY valid JSON array. NO explanation.
  // Format example:
  // [
  //   { "raw": "Cheeseburger", "qty": 2 },
  //   { "raw": "Coke", "qty": 1 }
  // ]
  
  // If quantity missing, set qty = 1.
  
  // User text: "${text}"
  // `;

  const prompt = `
You are a food order parser. Match user's spoken order to the closest item from this menu:

MENU:
${menuList}

Rules:
- Return ONLY valid JSON array, no explanation
- Match to the closest menu item name even if the user mispronounces it
- Format: [{ "raw": "<exact menu name>", "qty": <number> }]
- If quantity missing, set qty = 1

User order: "${text}"
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

 app.listen(3000, '0.0.0.0', () => { console.log("Server running on 3000") });
