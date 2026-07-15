import { encode } from "@toon-format/toon";

export function field<T>(key: string, as?: string): FieldDef<T> {
  return { type: "field", key, as };
}

export function pluck<T>(key: string, subkey: string, as?: string): FieldDef<T> {
  return { type: "pluck", key, subkey, as };
}

export function joinArray<T>(
  key: string,
  subkey: string | null,
  as?: string,
  empty = "none",
): FieldDef<T> {
  return { type: "joinArray", key, subkey, as, empty };
}

export function relativeTime<T>(key: string, as?: string): FieldDef<T> {
  return { type: "relativeTime", key, as };
}

export function boolYesNo<T>(key: string, as?: string): FieldDef<T> {
  return { type: "boolYesNo", key, as };
}

export function mapEnum<T>(
  key: string,
  map: Record<string, string>,
  fallback: string,
  as?: string,
): FieldDef<T> {
  return { type: "mapEnum", key, map, fallback, as };
}

export function lower<T>(key: string, as?: string): FieldDef<T> {
  return { type: "lower", key, as };
}

export function custom<T>(as: string, fn: (item: T) => unknown): FieldDef<T> {
  return { type: "custom", as, fn };
}

type Item = Record<string, any>;

export interface FieldDef<T> {
  type:
    | "field"
    | "pluck"
    | "joinArray"
    | "relativeTime"
    | "boolYesNo"
    | "mapEnum"
    | "lower"
    | "custom";
  key?: string;
  subkey?: string | null;
  as?: string;
  empty?: string;
  map?: Record<string, string>;
  fallback?: string;
  fn?: (item: T) => unknown;
}

/** Extract a configured subset of an item's fields into a plain object. */
export function extract<T>(item: T, schema: FieldDef<T>[]): Item {
  const record = item as Item;
  const result: Item = {};
  for (const def of schema) {
    const outputKey = def.as ?? def.key ?? def.as ?? "";
    switch (def.type) {
      case "field":
        result[outputKey] = record[def.key!] ?? null;
        break;
      case "pluck":
        result[outputKey] = record[def.key!]?.[def.subkey!] ?? null;
        break;
      case "joinArray": {
        const arr = record[def.key!];
        if (Array.isArray(arr) && arr.length > 0) {
          result[outputKey] = arr
            .map((x) =>
              typeof x === "string" ? x : x?.[def.subkey as string],
            )
            .join(",");
        } else {
          result[outputKey] = def.empty ?? "none";
        }
        break;
      }
      case "relativeTime":
        result[outputKey] = formatRelativeTime(record[def.key!]);
        break;
      case "boolYesNo":
        result[outputKey] = record[def.key!] ? "yes" : "no";
        break;
      case "mapEnum": {
        const val = record[def.key!];
        if (typeof val === "string" && val !== "" && def.map && val in def.map) {
          result[outputKey] = def.map[val];
        } else {
          result[outputKey] = def.fallback ?? val ?? "none";
        }
        break;
      }
      case "lower":
        result[outputKey] =
          typeof record[def.key!] === "string"
            ? record[def.key!].toLowerCase()
            : record[def.key!];
        break;
      case "custom":
        result[outputKey] = def.fn!(item);
        break;
      default:
        throw new Error(`Unknown field type: ${def.type}`);
    }
  }
  return result;
}

/** Render a labeled list of items as TOON. */
export function renderList<T>(
  label: string,
  items: T[],
  schema: FieldDef<T>[],
): string {
  const extracted = items.map((item) => extract(item, schema));
  return encode({ [label]: extracted });
}

/** Render a single labeled detail object as TOON. */
export function renderDetail<T>(
  label: string,
  item: T,
  schema: FieldDef<T>[],
): string {
  const extracted = extract(item, schema);
  return encode({ [label]: extracted });
}

/** Render help suggestions (manual formatting — encode() inlines primitive arrays). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

/** Combine multiple TOON blocks into a single output string. */
export function renderOutput(blocks: Array<string | undefined>): string {
  return blocks.filter(Boolean).join("\n");
}

function formatRelativeTime(iso: string | undefined | null): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "unknown";
  const MS_PER_SECOND = 1000;
  const diffSec = Math.floor((Date.now() - then) / MS_PER_SECOND);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  return `${Math.floor(diffMon / 12)}y ago`;
}

/** Render an error in TOON format. */
export function renderError(message: string, code: string, suggestions: string[] = []): string {
  const blocks: string[] = [encode({ error: message, code })];
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return blocks.join("\n");
}
