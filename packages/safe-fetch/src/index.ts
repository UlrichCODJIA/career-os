export interface SafeFetchRequest {
  readonly url: URL;
  readonly policyId: string;
  readonly maxResponseBytes: number;
}

export interface SafeFetchResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: URL;
}

export interface SafeFetchPort {
  fetch(request: SafeFetchRequest): Promise<SafeFetchResult>;
}
