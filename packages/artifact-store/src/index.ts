export interface StoredArtifact {
  readonly digest: string;
  readonly byteLength: number;
  readonly contentType: string;
}

export interface ArtifactStore {
  put(bytes: Uint8Array, contentType: string): Promise<StoredArtifact>;
  get(digest: string): Promise<Uint8Array | null>;
}
