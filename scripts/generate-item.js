#!/usr/bin/env node

// Usage: node scripts/generate-item.js <product-url>
// Fetches a product page, pulls out whatever structured info is available
// (title, brand, photo via JSON-LD / Open Graph), downloads the photo, and
// appends a new item to inventory.json. Dimensions and manual/PDF links are
// almost never present in a parseable form on product pages, so those are
// left blank for manual entry.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INVENTORY_PATH = path.join(ROOT, "inventory.json");
const PHOTOS_DIR = path.join(ROOT, "assets", "inventory");

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/generate-item.js <product-url>");
  process.exit(1);
}

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, "i"),
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return match[1];
  }
  return null;
}

function extractJsonLdProduct(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const s of scripts) {
    try {
      const data = JSON.parse(s[1]);
      const items = Array.isArray(data) ? data : (data["@graph"] || [data]);
      for (const item of items) {
        const type = item["@type"];
        if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
          return item;
        }
      }
    } catch {
      // malformed JSON-LD, skip
    }
  }
  return null;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function main() {
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InventoryBot/1.0)" },
  });
  if (!res.ok) {
    console.error(`Failed to fetch page: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const html = await res.text();

  const jsonLd = extractJsonLdProduct(html);

  const title = jsonLd?.name || extractMeta(html, "og:title") || null;
  const brandRaw = jsonLd?.brand;
  const brand =
    (typeof brandRaw === "string" ? brandRaw : brandRaw?.name) ||
    extractMeta(html, "og:site_name") ||
    null;
  const imageUrl =
    (Array.isArray(jsonLd?.image) ? jsonLd.image[0] : jsonLd?.image) ||
    extractMeta(html, "og:image") ||
    null;

  if (!title) {
    console.warn("⚠ Could not find a product title — you'll need to fill this in manually.");
  }

  fs.mkdirSync(PHOTOS_DIR, { recursive: true });

  const id = Date.now().toString(36);
  const slug = slugify(title || "item") + "-" + id;

  let photoPath = null;
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl);
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      let ext = path.extname(new URL(imageUrl).pathname).split("?")[0];
      if (!ext || ext.length > 5) ext = ".jpg";
      const filename = `${slug}${ext}`;
      fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
      photoPath = `assets/inventory/${filename}`;
      console.log(`✓ Photo saved to ${photoPath}`);
    } catch (err) {
      console.warn(`⚠ Could not download product photo: ${err.message}`);
    }
  } else {
    console.warn("⚠ No product photo found — add manually.");
  }

  const item = {
    id,
    name: title || "Unnamed item",
    brand: brand || null,
    link: url,
    photo: photoPath,
    dimensions: { width: null, height: null, depth: null, unit: "in" },
    manualUrl: null,
    room: null,
    addedAt: new Date().toISOString(),
  };

  let inventory = [];
  if (fs.existsSync(INVENTORY_PATH)) {
    inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, "utf-8"));
  }
  inventory.push(item);
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2) + "\n");

  console.log(`\nAdded "${item.name}" to inventory.json (id: ${item.id})`);
  if (!brand) console.log("  → brand: not found, edit inventory.json to add");
  console.log("  → dimensions: not auto-detected, edit inventory.json to add");
  console.log("  → manualUrl: not auto-detected, edit inventory.json to add");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
