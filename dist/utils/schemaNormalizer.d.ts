/**
 * Recursively ensures that all `type` fields in a JSON Schema are arrays instead
 * of single strings. This preserves schema validity while accommodating tools
 * such as Flowise that expect the array form.
 */
export declare function normalizeSchemaTypes(schema: unknown): unknown;
//# sourceMappingURL=schemaNormalizer.d.ts.map