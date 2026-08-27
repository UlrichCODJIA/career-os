import type { SQL } from "bun";
import {
  artifactStorageKey,
  redactArtifactMetadata,
  requireArtifactDigest,
  type ArtifactRequestMetadata,
  type ArtifactRetentionMetadata,
  type RetentionClaim,
  type StoredArtifact,
} from "@career-os/artifact-store";

export interface ArtifactCatalogInput {
  stored: StoredArtifact;
  metadata: ArtifactRequestMetadata;
  retrievedAt: Date;
  statusCode?: number;
  policyId?: string;
  retentionClass: string;
  deletionDueAt?: Date;
  compression?: string;
}

export interface ArtifactCatalogRecord {
  id: string;
  digest: string;
  storageState: "present" | "deleting" | "delete_failed" | "deleted" | "missing";
}

function requireLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("artifact batch limit must be between 1 and 1000");
  return limit;
}

function boundedError(message: string): string {
  return (message.replace(/[\r\n\t]+/g, " ").trim() || "artifact deletion failed").slice(0, 1_000);
}

export class PostgresArtifactMetadata implements ArtifactRetentionMetadata {
  constructor(private readonly sql: SQL) {}

  async record(input: ArtifactCatalogInput): Promise<ArtifactCatalogRecord> {
    if (!input.retentionClass.trim()) throw new Error("artifact retention class is required");
    requireArtifactDigest(input.stored.digest);
    if (input.stored.storageKey !== artifactStorageKey(input.stored.digest)) throw new Error("local artifact storage key does not match its digest");
    if (!Number.isSafeInteger(input.stored.byteLength) || input.stored.byteLength < 0) throw new Error("artifact byte length is invalid");
    if (input.statusCode !== undefined && (!Number.isInteger(input.statusCode) || input.statusCode < 100 || input.statusCode > 599)) {
      throw new Error("artifact status code is invalid");
    }
    const storageUri = `artifact://local/${input.stored.storageKey}`;
    const metadata = redactArtifactMetadata(input.metadata);
    const rows = await this.sql<{ id: string; digest: string; storageState: ArtifactCatalogRecord["storageState"] }[]>`
      INSERT INTO artifacts (
        id, sha256, byte_length, media_type, compression, storage_uri,
        canonical_source_url, retrieved_at, status_code, response_headers,
        policy_id, retention_class, deletion_due_at, metadata_redaction_version
      ) VALUES (
        ${crypto.randomUUID()}, ${input.stored.digest}, ${input.stored.byteLength}, ${input.stored.contentType},
        ${input.compression ?? null}, ${storageUri}, ${metadata.canonicalSourceUrl}, ${input.retrievedAt},
        ${input.statusCode ?? null}, ${JSON.stringify(metadata.responseHeaders)}::text::jsonb, ${input.policyId ?? null},
        ${input.retentionClass}, ${input.deletionDueAt ?? null}, ${metadata.redactionVersion}
      )
      ON CONFLICT (sha256) DO UPDATE SET
        storage_uri = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.storage_uri ELSE artifacts.storage_uri END,
        canonical_source_url = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.canonical_source_url ELSE artifacts.canonical_source_url END,
        retrieved_at = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.retrieved_at ELSE artifacts.retrieved_at END,
        response_headers = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.response_headers ELSE artifacts.response_headers END,
        retention_class = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.retention_class ELSE artifacts.retention_class END,
        deletion_due_at = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.deletion_due_at ELSE artifacts.deletion_due_at END,
        storage_state = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN 'present' ELSE artifacts.storage_state END,
        deletion_started_at = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN NULL ELSE artifacts.deletion_started_at END,
        deleted_at = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN NULL ELSE artifacts.deleted_at END,
        deletion_error = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN NULL ELSE artifacts.deletion_error END,
        metadata_redaction_version = CASE WHEN artifacts.storage_state IN ('deleted', 'missing', 'delete_failed') THEN EXCLUDED.metadata_redaction_version ELSE artifacts.metadata_redaction_version END
      RETURNING id, sha256 AS digest, storage_state AS "storageState"
    `;
    const record = rows[0];
    if (!record) throw new Error("artifact metadata write returned no record");
    if (record.storageState === "deleting") throw new Error("artifact is currently being deleted; retry the write");
    return record;
  }

  async claimDue(now: Date, limit: number): Promise<RetentionClaim[]> {
    const staleBefore = new Date(now.getTime() - 15 * 60_000);
    return this.sql.begin(async (tx) => tx<{ id: string; digest: string }[]>`
      WITH due AS (
        SELECT id FROM artifacts
        WHERE deletion_due_at <= ${now}
          AND (storage_state IN ('present', 'delete_failed') OR (storage_state = 'deleting' AND deletion_started_at < ${staleBefore}))
        ORDER BY deletion_due_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${requireLimit(limit)}
      )
      UPDATE artifacts AS artifact
      SET storage_state = 'deleting', deletion_started_at = ${now}, deletion_error = NULL
      FROM due WHERE artifact.id = due.id
      RETURNING artifact.id, artifact.sha256 AS digest
    `);
  }

  async completeDeletion(id: string, deletedAt: Date): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE artifacts SET storage_state = 'deleted', deletion_started_at = NULL, deleted_at = ${deletedAt},
        deletion_error = NULL, last_reconciled_at = ${deletedAt}
      WHERE id = ${id} AND storage_state = 'deleting' RETURNING id
    `;
    if (rows.length !== 1) throw new Error("artifact deletion claim is stale");
  }

  async failDeletion(id: string, message: string): Promise<void> {
    await this.sql`UPDATE artifacts SET storage_state = 'delete_failed', deletion_started_at = NULL,
      deletion_error = ${boundedError(message)} WHERE id = ${id} AND storage_state = 'deleting'`;
  }

  async hasDigest(digest: string): Promise<boolean> {
    const rows = await this.sql<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM artifacts WHERE sha256 = ${digest} AND storage_state <> 'deleted') AS present
    `;
    return rows[0]?.present ?? false;
  }

  async listPresentDigests(limit: number): Promise<Array<{ id: string; digest: string }>> {
    return this.sql<{ id: string; digest: string }[]>`
      SELECT id, sha256 AS digest FROM artifacts WHERE storage_state = 'present'
      ORDER BY COALESCE(last_reconciled_at, created_at), id LIMIT ${requireLimit(limit)}
    `;
  }

  async markMissing(id: string, checkedAt: Date): Promise<void> {
    await this.sql`UPDATE artifacts SET storage_state = 'missing', last_reconciled_at = ${checkedAt}
      WHERE id = ${id} AND storage_state = 'present'`;
  }
}
