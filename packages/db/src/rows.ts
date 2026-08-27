export interface MutableDatabaseRow {
  id: string;
  created_at: Date | string;
  updated_at: Date | string;
  row_version: number;
}

export interface MutableRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  rowVersion: number;
}

function toValidDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

export function mapMutableRow(row: MutableDatabaseRow): MutableRow {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)) {
    throw new Error("id must be a UUID");
  }
  if (!Number.isSafeInteger(row.row_version) || row.row_version < 1) {
    throw new Error("row_version must be a positive safe integer");
  }
  return {
    id: row.id,
    createdAt: toValidDate(row.created_at, "created_at"),
    updatedAt: toValidDate(row.updated_at, "updated_at"),
    rowVersion: row.row_version,
  };
}
