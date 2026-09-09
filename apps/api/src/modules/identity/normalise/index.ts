// Applied before any consistency check, never after (D10).
// Spec: docs/architecture.md §4.7.1

export { parseFlexibleDate, toIsoDate, datesMatch } from "./date.js";
export { normaliseGender, gendersMatch } from "./gender.js";
export { normaliseName, namesMatch } from "./name.js";
