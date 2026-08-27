import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = new Set([
  "age", "cache-control", "content-encoding", "content-language", "content-length",
  "content-type", "date", "etag", "last-modified", "retry-after", "x-request-id",
]);
const SENSITIVE_QUERY_NAME = /(?:^|[-_])(auth|authorization|credential|key|password|secret|sig|signature|token)(?:$|[-_])/i;
const SENSITIVE_QUERY_COMPACT = new Set([
  "accesstoken", "apikey", "authorization", "awsaccesskeyid", "clientsecret", "code",
  "googleaccessid", "idtoken", "jwt", "password", "session", "signature", "ticket",
]);
const SENSITIVE_QUERY_FRAGMENT = /(access.?key|authorization|credential|password|secret|signature|token)/i;
const NESTED_CREDENTIAL_FRAGMENT = /(?:^|[?&])(authorization|credential|password|secret|signature|token|x-amz-signature|x-goog-signature)=/i;

export type ArtifactDigest = string;

export interface StoredArtifact {
  readonly digest: ArtifactDigest;
  readonly byteLength: number;
  readonly contentType: string;
  readonly storageKey: string;
  readonly created: boolean;
}

export interface StoredArtifactObject {
  readonly digest: ArtifactDigest;
  readonly byteLength: number;
  readonly modifiedAt: Date;
}

export interface ArtifactStore {
  put(bytes: Uint8Array, contentType: string): Promise<StoredArtifact>;
  get(digest: ArtifactDigest): Promise<Uint8Array | null>;
  has(digest: ArtifactDigest): Promise<boolean>;
  delete(digest: ArtifactDigest): Promise<"deleted" | "absent">;
  list(): Promise<StoredArtifactObject[]>;
}

export interface ArtifactRequestMetadata {
  canonicalSourceUrl: string;
  responseHeaders?: Headers | Record<string, string | string[] | undefined>;
}

export interface RedactedArtifactMetadata {
  canonicalSourceUrl: string;
  responseHeaders: Record<string, string>;
  redactionVersion: "artifact-metadata-v1";
}

export function sha256(bytes: Uint8Array): ArtifactDigest {
  return createHash("sha256").update(bytes).digest("hex");
}

export function requireArtifactDigest(value: string): ArtifactDigest {
  if (!SHA256_PATTERN.test(value)) throw new Error("artifact digest must be 64 lowercase hexadecimal characters");
  return value;
}

export function artifactStorageKey(digest: ArtifactDigest): string {
  const valid = requireArtifactDigest(digest);
  return `sha256/${valid.slice(0, 2)}/${valid}`;
}

function redactUrl(value: string): string {
  if (value.length > 8_192) throw new Error("artifact source URL is too long");
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const name of [...url.searchParams.keys()]) {
    const lower = name.toLowerCase();
    const compact = lower.replaceAll(/[-_]/g, "");
    const queryValue = url.searchParams.get(name) ?? "";
    if (lower.startsWith("x-amz-") || lower.startsWith("x-goog-") || SENSITIVE_QUERY_NAME.test(name)
      || SENSITIVE_QUERY_COMPACT.has(compact) || SENSITIVE_QUERY_FRAGMENT.test(compact)
      || NESTED_CREDENTIAL_FRAGMENT.test(queryValue)) {
      url.searchParams.delete(name);
    }
  }
  url.hash = "";
  return url.toString();
}

function headerEntries(headers: ArtifactRequestMetadata["responseHeaders"]): Array<[string, string]> {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  return Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(", ") : value]];
  });
}

export function redactArtifactMetadata(metadata: ArtifactRequestMetadata): RedactedArtifactMetadata {
  const responseHeaders: Record<string, string> = {};
  for (const [rawName, rawValue] of headerEntries(metadata.responseHeaders)) {
    const name = rawName.toLowerCase();
    if (SAFE_RESPONSE_HEADERS.has(name)) responseHeaders[name] = rawValue.slice(0, 4_096);
    if (name === "location") {
      try { responseHeaders.location = redactUrl(rawValue); } catch { /* Drop relative or malformed redirect metadata. */ }
    }
  }
  return {
    canonicalSourceUrl: redactUrl(metadata.canonicalSourceUrl),
    responseHeaders,
    redactionVersion: "artifact-metadata-v1",
  };
}

export interface LocalArtifactStoreOptions {
  root: string;
  maxBytes?: number;
  beforeCommit?: (temporaryPath: string, finalPath: string) => void | Promise<void>;
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #configuredRoot: string;
  readonly #beforeCommit?: LocalArtifactStoreOptions["beforeCommit"];
  readonly #maxBytes: number;
  readonly #ready: Promise<string>;

  constructor(options: LocalArtifactStoreOptions) {
    if (!options.root.trim()) throw new Error("artifact root is required");
    this.#configuredRoot = resolve(options.root);
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) throw new Error("artifact byte limit must be a positive safe integer");
    this.#beforeCommit = options.beforeCommit;
    this.#ready = this.#initialize();
  }

  async #initialize(): Promise<string> {
    await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#configuredRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("artifact root must be a real directory");
    return realpath(this.#configuredRoot);
  }

  async #pathFor(digest: ArtifactDigest, createDirectory: boolean): Promise<{ directory: string; path: string }> {
    requireArtifactDigest(digest);
    const root = await this.#ready;
    const key = artifactStorageKey(digest);
    const directory = join(root, "sha256", digest.slice(0, 2));
    const path = join(root, ...key.split("/"));
    const escaped = relative(root, path);
    if (escaped === "" || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
      throw new Error("artifact path escaped its configured root");
    }
    if (createDirectory) await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const component of [join(root, "sha256"), directory]) {
      try {
        const info = await lstat(component);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("artifact path contains a non-directory or symbolic link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !createDirectory) break;
        throw error;
      }
    }
    return { directory, path };
  }

  async #readVerified(digest: ArtifactDigest, path: string): Promise<Uint8Array | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("artifact object must be a regular file");
      if (info.size > this.#maxBytes) throw new Error("artifact object exceeds the configured byte limit");
      const bytes = new Uint8Array(await readFile(path));
      if (bytes.byteLength > this.#maxBytes) throw new Error("artifact object exceeds the configured byte limit");
      if (sha256(bytes) !== digest) throw new Error("artifact bytes do not match their digest key");
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(bytes: Uint8Array, contentType: string): Promise<StoredArtifact> {
    if (!(bytes instanceof Uint8Array)) throw new Error("artifact bytes must be a Uint8Array");
    if (bytes.byteLength > this.#maxBytes) throw new Error("artifact bytes exceed the configured byte limit");
    if (!contentType.trim() || contentType.length > 255 || /[\r\n]/.test(contentType)) throw new Error("artifact content type is invalid");
    const digest = sha256(bytes);
    const target = await this.#pathFor(digest, true);
    const existing = await this.#readVerified(digest, target.path);
    if (existing) {
      return { digest, byteLength: existing.byteLength, contentType, storageKey: artifactStorageKey(digest), created: false };
    }

    const temporaryPath = join(target.directory, `.${digest}.${crypto.randomUUID()}.tmp`);
    let committed = false;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#beforeCommit?.(temporaryPath, target.path);
      let created = true;
      try {
        await link(temporaryPath, target.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raced = await this.#readVerified(digest, target.path);
        if (!raced) throw new Error("artifact deduplication race did not produce a valid object");
        created = false;
      }
      await rm(temporaryPath);
      committed = true;
      const stored = await this.#readVerified(digest, target.path);
      if (!stored) throw new Error("atomic artifact commit did not create the object");
      return { digest, byteLength: stored.byteLength, contentType, storageKey: artifactStorageKey(digest), created };
    } finally {
      if (!committed) await rm(temporaryPath, { force: true });
    }
  }

  async get(digest: ArtifactDigest): Promise<Uint8Array | null> {
    requireArtifactDigest(digest);
    const target = await this.#pathFor(digest, false);
    return this.#readVerified(digest, target.path);
  }

  async has(digest: ArtifactDigest): Promise<boolean> {
    return (await this.get(digest)) !== null;
  }

  async delete(digest: ArtifactDigest): Promise<"deleted" | "absent"> {
    requireArtifactDigest(digest);
    const target = await this.#pathFor(digest, false);
    const bytes = await this.#readVerified(digest, target.path);
    if (!bytes) return "absent";
    await rm(target.path);
    return "deleted";
  }

  async list(): Promise<StoredArtifactObject[]> {
    const root = await this.#ready;
    const algorithmRoot = join(root, "sha256");
    try {
      const prefixes = await readdir(algorithmRoot, { withFileTypes: true });
      const objects: StoredArtifactObject[] = [];
      for (const prefix of prefixes) {
        if (!/^[0-9a-f]{2}$/.test(prefix.name) || !prefix.isDirectory() || prefix.isSymbolicLink()) continue;
        const directory = join(algorithmRoot, prefix.name);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!SHA256_PATTERN.test(entry.name) || !entry.isFile() || entry.isSymbolicLink() || !entry.name.startsWith(prefix.name)) continue;
          const path = join(directory, entry.name);
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) continue;
          objects.push({ digest: entry.name, byteLength: info.size, modifiedAt: info.mtime });
        }
      }
      return objects.sort((left, right) => left.digest.localeCompare(right.digest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export interface RetentionClaim {
  id: string;
  digest: ArtifactDigest;
}

export interface ArtifactRetentionMetadata {
  claimDue(now: Date, limit: number): Promise<RetentionClaim[]>;
  completeDeletion(id: string, deletedAt: Date): Promise<void>;
  failDeletion(id: string, message: string): Promise<void>;
  hasDigest(digest: ArtifactDigest): Promise<boolean>;
  listPresentDigests(limit: number): Promise<Array<{ id: string; digest: ArtifactDigest }>>;
  markMissing(id: string, checkedAt: Date): Promise<void>;
}

export class ArtifactRetentionService {
  constructor(private readonly store: ArtifactStore, private readonly metadata: ArtifactRetentionMetadata) {}

  async deleteExpired(now = new Date(), limit = 100): Promise<{ deleted: number; failed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("retention limit must be between 1 and 1000");
    const claims = await this.metadata.claimDue(now, limit);
    let deleted = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        await this.store.delete(claim.digest);
        await this.metadata.completeDeletion(claim.id, now);
        deleted += 1;
      } catch (error) {
        await this.metadata.failDeletion(claim.id, error instanceof Error ? error.message : "unknown artifact deletion failure");
        failed += 1;
      }
    }
    return { deleted, failed };
  }

  async reconcile(now = new Date(), orphanGraceMs = 86_400_000): Promise<{ orphansDeleted: number; missingMarked: number }> {
    if (!Number.isFinite(orphanGraceMs) || orphanGraceMs < 0) throw new Error("orphan grace must be non-negative");
    let orphansDeleted = 0;
    for (const object of await this.store.list()) {
      if (object.modifiedAt.getTime() > now.getTime() - orphanGraceMs) continue;
      if (!(await this.metadata.hasDigest(object.digest))) {
        await this.store.delete(object.digest);
        orphansDeleted += 1;
      }
    }
    let missingMarked = 0;
    for (const artifact of await this.metadata.listPresentDigests(1_000)) {
      if (!(await this.store.has(artifact.digest))) {
        await this.metadata.markMissing(artifact.id, now);
        missingMarked += 1;
      }
    }
    return { orphansDeleted, missingMarked };
  }
}
