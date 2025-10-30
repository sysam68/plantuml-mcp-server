/**
 * Recursively ensures all `type` fields are arrays of non-empty strings.
 * If `type` is missing or invalid, it is removed (not replaced by []).
 */
export function normalizeSchemaTypes(schema: any): any {
  if (typeof schema !== "object" || schema === null) return schema;

  const clone = Array.isArray(schema)
    ? schema.map(normalizeSchemaTypes)
    : { ...schema };

  if (Object.prototype.hasOwnProperty.call(clone, "type")) {
    if (typeof clone.type === "string" && clone.type.trim() !== "") {
      clone.type = [clone.type];
    } else if (Array.isArray(clone.type) && clone.type.length === 0) {
      delete clone.type; // ⚠️ avoid empty arrays that crash Flowise
    } else if (clone.type == null) {
      delete clone.type;
    }
  }

  for (const key of Object.keys(clone)) {
    if (typeof clone[key] === "object") {
      clone[key] = normalizeSchemaTypes(clone[key]);
    }
  }

  return clone;
}
