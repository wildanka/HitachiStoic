import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Fuse from "fuse.js";

// One JSON file per outlet: catalogs/<outletId>.json
// (Stand-in for a database. Data only, so it can be rewritten at runtime
// without restarting and without executing anything that came off the wire.)
const CATALOG_DIR = path.resolve(process.env.CATALOG_DIR ?? "catalogs");

const CATEGORY_PAGE_SIZE = 50;
const ITEM_PAGE_SIZE = 20;
const MAX_PAGES = 500; // safety net against an API that ignores the page param
const FETCH_TIMEOUT_MS = 15_000;

// outletId -> { items, menuList, fuse, updatedAt }
const cache = new Map();
// outletId -> in-flight update promise, so two updates can't interleave
const updating = new Map();

export class CatalogError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function normalizeOutletId(value) {
  const id = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  // Used as a filename, so keep it to a safe charset.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new CatalogError(400, "outletId must be 1-64 characters of letters, digits, '-' or '_'");
  }
  return id;
}

function catalogFile(outletId) {
  return path.join(CATALOG_DIR, `${outletId}.json`);
}

function buildEntry(doc) {
  const items = doc.items;
  return {
    items,
    updatedAt: doc.updatedAt,
    menuList: items.map((m) => `- ${m.name}`).join("\n"),
    fuse: new Fuse(items, { keys: ["name"], threshold: 0.5, includeScore: true }),
  };
}

// Returns the outlet's catalog, reading it from disk on first use.
export async function getCatalog(outletId) {
  const cached = cache.get(outletId);
  if (cached) return cached;

  let doc;
  try {
    doc = JSON.parse(await readFile(catalogFile(outletId), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new CatalogError(404, `No catalog for outlet ${outletId}. Call POST /update-catalog first.`);
    }
    throw new CatalogError(500, `Catalog file for outlet ${outletId} is unreadable: ${e.message}`);
  }

  if (!Array.isArray(doc?.items) || doc.items.length === 0) {
    throw new CatalogError(409, `Catalog for outlet ${outletId} is empty. Call POST /update-catalog.`);
  }

  const entry = buildEntry(doc);
  cache.set(outletId, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Fetching from the upstream catalog API
// ---------------------------------------------------------------------------

async function getJson(url, authToken) {
  const headers = { Accept: "application/json" };
  if (authToken) headers.Authorization = authToken;

  let response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new CatalogError(502, `Cannot reach ${url.origin}${url.pathname}: ${e.message}`);
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new CatalogError(
      502,
      `${url.origin}${url.pathname} returned ${response.status}: ${text.slice(0, 300)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CatalogError(502, `${url.origin}${url.pathname} did not return JSON`);
  }
}

function isPage(v) {
  return v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.content);
}

// Pulls one page of records out of a response. Prefers a Spring-style page
// object ({ content, last, totalPages }) under the hinted key, then any page
// object, then a bare array under the hinted key. Responses are wrapped as
// { data: { ... } }, so look one level down too.
function extractPage(json, { pagedKey, listKey }) {
  const roots = [json?.data, json?.data?.data, json].filter((r) => r && typeof r === "object");

  for (const root of roots) {
    if (isPage(root[pagedKey])) return toPage(root[pagedKey]);
  }
  for (const root of roots) {
    if (isPage(root)) return toPage(root);
    const anyPaged = Object.values(root).find(isPage);
    if (anyPaged) return toPage(anyPaged);
  }
  for (const root of roots) {
    if (Array.isArray(root[listKey])) return { records: root[listKey], last: null };
    if (Array.isArray(root)) return { records: root, last: null };
  }
  return null;
}

function toPage(p) {
  let last = null;
  if (typeof p.last === "boolean") last = p.last;
  else {
    const number = p.number ?? p.page?.number ?? p.pageable?.pageNumber;
    const total = p.totalPages ?? p.page?.totalPages;
    if (Number.isInteger(number) && Number.isInteger(total)) last = number + 1 >= total;
  }
  return { records: p.content, last };
}

// Walks page0 = 0, 1, 2, ... until the API says it's the last page (or, if it
// doesn't say, until a short/empty/repeated page).
async function fetchAllPages(baseUrl, { params, size, authToken, pagedKey, listKey, label }) {
  const all = [];
  let previousFirstId;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("size", String(size));
    url.searchParams.set("page0", String(page));

    const json = await getJson(url, authToken);
    const result = extractPage(json, { pagedKey, listKey });
    if (!result) {
      throw new CatalogError(502, `Unrecognised ${label} response shape from ${url.origin}${url.pathname}`);
    }

    const { records, last } = result;
    if (records.length === 0) break;

    // Guard against an API that ignores page0 and keeps returning page 0.
    const firstId = records[0]?.id;
    if (page > 0 && firstId !== undefined && firstId === previousFirstId) break;
    previousFirstId = firstId;

    all.push(...records);

    if (last === true) break;
    if (last === null && records.length < size) break;
    if (page === MAX_PAGES - 1) {
      throw new CatalogError(502, `${label}: gave up after ${MAX_PAGES} pages`);
    }
  }

  return all;
}

function parseUrl(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CatalogError(400, `${field} is required`);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CatalogError(400, `${field} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CatalogError(400, `${field} must be http(s)`);
  }
  return url;
}

async function fetchCatalog({ categoryListUrl, categoryItemListUrl, authToken }) {
  const categories = (
    await fetchAllPages(categoryListUrl, {
      params: {},
      size: CATEGORY_PAGE_SIZE,
      authToken,
      pagedKey: "categoriesPaged",
      listKey: "categories",
      label: "category list",
    })
  ).filter((c) => c && c.id != null && c.active !== false);

  // The same item can sit in several categories (e.g. "Most Popular"), so
  // merge by id and remember every category it appeared under.
  const byId = new Map();
  const perCategory = [];

  for (const category of categories) {
    const records = await fetchAllPages(categoryItemListUrl, {
      params: { categoryId: category.id },
      size: ITEM_PAGE_SIZE,
      authToken,
      // Items come back as a page object at data.items (not a bare list).
      pagedKey: "items",
      listKey: "items",
      label: `items of category ${category.id}`,
    });

    let kept = 0;
    for (const r of records) {
      const name = (r?.name ?? r?.itemName ?? r?.title ?? "").toString().trim();
      if (r?.id == null || !name || r.active === false) continue;

      const existing = byId.get(r.id);
      if (existing) {
        if (!existing.categoryIds.includes(category.id)) existing.categoryIds.push(category.id);
      } else {
        byId.set(r.id, { id: r.id, name, categoryIds: [category.id] });
      }
      kept++;
    }
    perCategory.push({ id: category.id, name: category.name, items: kept });
  }

  return {
    items: [...byId.values()],
    categories: perCategory,
  };
}

export async function updateCatalog(outletId, body) {
  const categoryListUrl = parseUrl(body?.categoryListUrl, "categoryListUrl");
  const categoryItemListUrl = parseUrl(body?.categoryItemListUrl, "categoryItemListUrl");
  const authToken = typeof body?.authToken === "string" ? body.authToken.trim() : "";

  if (updating.has(outletId)) {
    throw new CatalogError(409, `A catalog update for outlet ${outletId} is already running`);
  }

  const job = (async () => {
    const { items, categories } = await fetchCatalog({
      categoryListUrl,
      categoryItemListUrl,
      authToken,
    });

    if (items.length === 0) {
      // Don't wipe a working catalog because the upstream returned nothing.
      throw new CatalogError(502, "Upstream returned no active items; existing catalog left as is");
    }

    const doc = {
      outletId,
      updatedAt: new Date().toISOString(),
      categories,
      items,
    };

    // Write to a temp file then rename, so a reader never sees half a file.
    await mkdir(CATALOG_DIR, { recursive: true });
    const file = catalogFile(outletId);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, file);

    cache.set(outletId, buildEntry(doc));
    return { outletId, updatedAt: doc.updatedAt, itemCount: items.length, categories };
  })();

  updating.set(outletId, job);
  try {
    return await job;
  } finally {
    updating.delete(outletId);
  }
}
