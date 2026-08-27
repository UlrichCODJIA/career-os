import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { sameAddress } from "./ip.ts";

export interface TransportRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxWireBytes: number;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly remoteAddress: string;
}

export interface SafeFetchTransport {
  request(input: TransportRequest): Promise<TransportResponse>;
}

function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function normalizedHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

export class NodeSafeFetchTransport implements SafeFetchTransport {
  request(input: TransportRequest): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      const lookup: LookupFunction = (_hostname, _options, callback) => callback(null, input.address, input.family);
      const options: https.RequestOptions = {
        method: "GET",
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port || 443,
        path: `${input.url.pathname}${input.url.search}`,
        headers: input.headers,
        lookup,
        servername: input.url.hostname,
        rejectUnauthorized: true,
        agent: false,
        timeout: input.timeoutMs,
      };
      // node:https does not inherit HTTP(S)_PROXY. DNS is pinned by the custom lookup.
      const request = https.request(options, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > input.maxWireBytes) {
            response.destroy(new Error("wire_limit_exceeded"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const remoteAddress = normalizeAddress(response.socket.remoteAddress);
          if (!remoteAddress || !sameAddress(remoteAddress, normalizeAddress(input.address)) || isIP(remoteAddress) === 0) {
            reject(new Error("remote_address_mismatch"));
            return;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: normalizedHeaders(response.headers),
            body: Buffer.concat(chunks),
            remoteAddress,
          });
        });
      });
      const abort = () => request.destroy(new Error("request_aborted"));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      request.once("close", () => input.signal.removeEventListener("abort", abort));
      request.once("timeout", () => request.destroy(new Error("request_timeout")));
      request.once("error", reject);
      request.end();
    });
  }
}
