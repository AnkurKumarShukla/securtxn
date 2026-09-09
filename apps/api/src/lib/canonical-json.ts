// Deterministic JSON serialisation.
//
// `JSON.stringify` does NOT guarantee key order across engines or versions, and
// object key order is an implementation detail of how the object was built. Two
// runs that produce the same logical payload can serialise differently, hash
// differently, and break a chain that is actually intact.
//
// This is the one place that determinism is established. Everything downstream
// depends on it.
//
// Spec: docs/architecture.md §4.8

/**
 * Serialises a value with object keys sorted, recursively.
 *
 * Rejects anything JSON cannot round-trip. `undefined` silently disappears,
 * `NaN` and `Infinity` silently become `null`, and a function vanishes — each
 * would produce a hash over something other than what the caller passed.
 * Failing loudly is the only safe behaviour when the output is evidence.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialise(value, new WeakSet(), "$");
}

function serialise(value: unknown, seen: WeakSet<object>, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);

    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonical JSON: ${path} is ${String(value)}, which JSON cannot represent`);
      }
      // JSON.stringify already emits the shortest round-trippable form.
      return JSON.stringify(value);

    case "boolean":
      return value ? "true" : "false";

    case "bigint":
      // Deliberate: a bigint has no JSON form, and silently coercing it would
      // lose precision on exactly the values big enough to need it.
      throw new TypeError(`canonical JSON: ${path} is a bigint; convert it to a string first`);

    case "undefined":
    case "function":
    case "symbol":
      throw new TypeError(`canonical JSON: ${path} is ${typeof value}, which JSON cannot represent`);

    case "object":
      break;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError(`canonical JSON: ${path} is a circular reference`);
  }
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      // Array order is meaningful and preserved — only object keys are sorted.
      return `[${object.map((item, i) => serialise(item, seen, `${path}[${i}]`)).join(",")}]`;
    }

    if (object instanceof Date) {
      // ISO 8601, UTC. A Date's default JSON form is already this, but making
      // it explicit stops a locale or engine change from altering a hash.
      return JSON.stringify(object.toISOString());
    }

    const entries = Object.entries(object as Record<string, unknown>)
      // `undefined` members are dropped rather than rejected: that is how an
      // optional field that was never set arrives, and it is not an error.
      .filter(([, v]) => v !== undefined)
      // Sorted by code unit, which is stable across engines and locales —
      // localeCompare is not.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const body = entries
      .map(([key, v]) => `${JSON.stringify(key)}:${serialise(v, seen, `${path}.${key}`)}`)
      .join(",");

    return `{${body}}`;
  } finally {
    seen.delete(object);
  }
}
