// Safe access to values of unknown shape (tool inputs and results, parsed JSON).

export type UnknownRecord = Readonly<Record<string, unknown>>;

export function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function stringField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];

  return typeof field === 'string' ? field : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
  const field = asRecord(value)?.[key];

  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

export function booleanField(value: unknown, key: string): boolean | undefined {
  const field = asRecord(value)?.[key];

  return typeof field === 'boolean' ? field : undefined;
}

export function arrayField(value: unknown, key: string): readonly unknown[] | undefined {
  const field = asRecord(value)?.[key];

  return Array.isArray(field) ? field : undefined;
}
