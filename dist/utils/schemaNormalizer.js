/**
 * Recursively ensures that all `type` fields in a JSON Schema are arrays instead
 * of single strings. This preserves schema validity while accommodating tools
 * such as Flowise that expect the array form.
 */
export function normalizeSchemaTypes(schema) {
    if (typeof schema !== 'object' || schema === null) {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map((item) => normalizeSchemaTypes(item));
    }
    const clone = { ...schema };
    if (typeof clone.type === 'string') {
        clone.type = [clone.type];
        console.log(`[PATCH] Normalized schema "type": ${clone.type}`);
    }
    for (const key of Object.keys(clone)) {
        const value = clone[key];
        if (typeof value === 'object' && value !== null) {
            clone[key] = normalizeSchemaTypes(value);
        }
    }
    return clone;
}
//# sourceMappingURL=schemaNormalizer.js.map