/**
 * OFD Receipt HTML Parser
 * Parses ofd.soliq.uz check pages and extracts receipt line items.
 *
 * Tries multiple strategies in order:
 *   1. Embedded JSON (window.__DATA__, script[type="application/json"], etc.)
 *   2. HTML table rows with numeric price columns
 *   3. CSS-class-keyed div/span structure
 */

export interface OfdParsedItem {
  id: string;
  name: string;
  unitPrice: number;
  quantity: number;
  totalPrice: number;
  kind: "item" | "fee" | "discount";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _uid = 0;
function nextId(): string {
  return `ofd-${++_uid}`;
}

/** Strip HTML tags, collapse whitespace, decode common entities */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a localised number string: "1 234,56" or "1234.56" → 1234.56 */
function parseNum(s: string): number {
  const cleaned = s.replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Strategy 1: JSON extraction ───────────────────────────────────────────────

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Known property names for receipt items, in priority order */
const ITEM_ARRAY_KEYS = [
  "items",
  "products",
  "rows",
  "lines",
  "mahsulotlar", // Uzbek: products
  "tovarlar", // Uzbek: goods
  "товары",
  "позиции",
];
const NAME_KEYS = ["name", "productName", "nomi", "товар", "наименование", "product"];
const QTY_KEYS = ["qty", "quantity", "count", "miqdori", "количество", "кол"];
const UNIT_PRICE_KEYS = ["price", "unitPrice", "narx", "цена", "narxi"];
const TOTAL_KEYS = ["total", "totalPrice", "summa", "sum", "итого", "jami"];

function pickStr(obj: Record<string, JsonValue>, keys: string[]): string {
  for (const k of keys) {
    if (typeof obj[k] === "string") return obj[k] as string;
    if (typeof obj[k] === "number") return String(obj[k]);
  }
  return "";
}

function pickNum(obj: Record<string, JsonValue>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseNum(v);
      if (n > 0) return n;
    }
  }
  return 0;
}

function tryExtractItemsFromJson(parsed: JsonValue): OfdParsedItem[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const root = parsed as Record<string, JsonValue>;

  // Walk one level of nesting
  const candidates: JsonValue[][] = [];
  for (const k of ITEM_ARRAY_KEYS) {
    if (Array.isArray(root[k])) candidates.push(root[k] as JsonValue[]);
  }
  // Also try nested: root.data.items, root.receipt.items, etc.
  for (const nested of ["data", "receipt", "check", "payload"]) {
    const sub = root[nested];
    if (sub && typeof sub === "object" && !Array.isArray(sub)) {
      const subObj = sub as Record<string, JsonValue>;
      for (const k of ITEM_ARRAY_KEYS) {
        if (Array.isArray(subObj[k])) candidates.push(subObj[k] as JsonValue[]);
      }
    }
  }

  for (const arr of candidates) {
    const items: OfdParsedItem[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const obj = raw as Record<string, JsonValue>;
      const name = pickStr(obj, NAME_KEYS);
      if (!name) continue;
      const qty = pickNum(obj, QTY_KEYS) || 1;
      let unitPrice = pickNum(obj, UNIT_PRICE_KEYS);
      let totalPrice = pickNum(obj, TOTAL_KEYS);
      if (unitPrice <= 0 && totalPrice > 0) unitPrice = round2(totalPrice / qty);
      if (totalPrice <= 0) totalPrice = round2(unitPrice * qty);
      if (unitPrice <= 0) continue;
      items.push({
        id: nextId(),
        name,
        quantity: qty,
        unitPrice: round2(unitPrice),
        totalPrice: round2(totalPrice),
        kind: "item",
      });
    }
    if (items.length > 0) return items;
  }
  return [];
}

function tryJsonStrategy(html: string): OfdParsedItem[] {
  // Patterns to find JSON blobs in script content
  const patterns: RegExp[] = [
    /window\.__(?:DATA|STATE|RECEIPT|CHECK|APP)__\s*=\s*(\{[\s\S]*?\});\s*(?:<\/script>|var |window\.)/i,
    /var\s+(?:data|receipt|check|appState)\s*=\s*(\{[\s\S]*?\});/i,
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /data-initial=["']([\s\S]*?)["']/i,
  ];

  for (const pattern of patterns) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "");
    let match: RegExpExecArray | null;
    // For non-global patterns use .exec once; for global iterate
    const isGlobal = globalPattern.flags.includes("g");
    if (isGlobal) {
      while ((match = globalPattern.exec(html)) !== null) {
        try {
          const parsed: JsonValue = JSON.parse(match[1]!);
          const items = tryExtractItemsFromJson(parsed);
          if (items.length > 0) return items;
        } catch { /* ignore */ }
      }
    } else {
      match = globalPattern.exec(html);
      if (match) {
        try {
          const parsed: JsonValue = JSON.parse(match[1]!);
          const items = tryExtractItemsFromJson(parsed);
          if (items.length > 0) return items;
        } catch { /* ignore */ }
      }
    }
  }
  return [];
}

// ── Strategy 2: HTML table rows ───────────────────────────────────────────────

/** Keywords that signal a header row to skip */
const HEADER_KEYWORDS =
  /^(name|наим|nomi|qty|кол|сон|price|нарх|narx|сум|sum|total|жами|unit|бирл|item|товар|услуг|desc|amount)/i;

function tryTableStrategy(html: string): OfdParsedItem[] {
  // Strip scripts and styles first
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const items: OfdParsedItem[] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(cleanHtml)) !== null) {
    const rowContent = rowMatch[1]!;
    const cells = [...rowContent.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      stripTags(m[1]!)
    );

    if (cells.length < 3) continue;

    // Skip header-like rows
    if (cells.slice(0, 2).some((c) => HEADER_KEYWORDS.test(c))) continue;

    const name = cells[0]!;
    if (!name || name.length < 2 || name.length > 200) continue;

    // All non-first cells
    const rest = cells.slice(1);
    const numericCells = rest
      .filter((c) => /^[\d\s,.]+$/.test(c) && parseNum(c) > 0)
      .map(parseNum);

    if (numericCells.length === 0) continue;

    let qty = 1;
    let unitPrice = 0;
    let totalPrice = 0;

    if (numericCells.length >= 3) {
      qty = numericCells[0]!;
      unitPrice = numericCells[1]!;
      totalPrice = numericCells[2]!;
    } else if (numericCells.length === 2) {
      // Could be (qty, total) or (unitPrice, total)
      // Heuristic: if first is a small integer ≤ 999, treat as qty
      const first = numericCells[0]!;
      const second = numericCells[1]!;
      if (first === Math.floor(first) && first <= 999 && first >= 1) {
        qty = first;
        totalPrice = second;
        unitPrice = round2(second / qty);
      } else {
        unitPrice = first;
        totalPrice = second;
      }
    } else {
      unitPrice = totalPrice = numericCells[0]!;
    }

    if (unitPrice <= 0 && totalPrice <= 0) continue;
    if (unitPrice <= 0) unitPrice = round2(totalPrice / (qty || 1));
    if (totalPrice <= 0) totalPrice = round2(unitPrice * qty);

    items.push({
      id: nextId(),
      name,
      quantity: qty,
      unitPrice: round2(unitPrice),
      totalPrice: round2(totalPrice),
      kind: "item",
    });
  }
  return items;
}

// ── Strategy 3: CSS-class div/span structure ─────────────────────────────────

function tryDivStrategy(html: string): OfdParsedItem[] {
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const items: OfdParsedItem[] = [];

  // Look for blocks that contain both a text label and at least one price
  // Common class patterns: check-item, receipt-item, item-row, product-row, etc.
  const blockPattern =
    /<(?:div|li|tr|section)[^>]*class="[^"]*(?:item|row|product|tovar|mahsulot)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li|tr|section)>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockPattern.exec(cleanHtml)) !== null) {
    const blockContent = blockMatch[1]!;
    const text = stripTags(blockContent);
    if (!text || text.length < 3) continue;

    // Extract all numbers from the block
    const nums = [...text.matchAll(/[\d\s]{1,15}(?:[.,]\d{1,2})?/g)]
      .map((m) => parseNum(m[0]))
      .filter((n) => n > 0);

    if (nums.length === 0) continue;

    // Take everything before the first number as the name
    const firstNumIdx = text.search(/[\d]/);
    const name = text.slice(0, firstNumIdx).trim().replace(/[:\-–—]+$/, "").trim();
    if (!name || name.length < 2) continue;

    let qty = 1;
    let unitPrice = 0;
    let totalPrice = 0;

    if (nums.length >= 3) {
      qty = nums[0]!;
      unitPrice = nums[1]!;
      totalPrice = nums[2]!;
    } else if (nums.length === 2) {
      unitPrice = nums[0]!;
      totalPrice = nums[1]!;
    } else {
      unitPrice = totalPrice = nums[0]!;
    }

    if (unitPrice <= 0) continue;
    if (totalPrice <= 0) totalPrice = round2(unitPrice * qty);

    items.push({
      id: nextId(),
      name,
      quantity: qty,
      unitPrice: round2(unitPrice),
      totalPrice: round2(totalPrice),
      kind: "item",
    });
  }
  return items;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Parse an OFD check HTML page and return extracted line items.
 * Returns an empty array if nothing could be extracted.
 */
export function parseOfdHtml(html: string): OfdParsedItem[] {
  // Reset uid counter per parse run so IDs stay short
  _uid = 0;

  // Strategy 1: embedded JSON
  const fromJson = tryJsonStrategy(html);
  if (fromJson.length > 0) return fromJson;

  // Strategy 2: HTML table rows
  const fromTable = tryTableStrategy(html);
  if (fromTable.length > 0) return fromTable;

  // Strategy 3: CSS-class div/span blocks
  return tryDivStrategy(html);
}
