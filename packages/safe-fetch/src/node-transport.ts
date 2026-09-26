import * as tls from "node:tls";
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

const MAX_HEADER_BYTES = 64 * 1024;

function normalizeAddress(address: string | undefined): string {
  if (!address) return "";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function dechunk(body: Buffer, maximum: number): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", offset, "ascii");
    if (lineEnd < 0 || lineEnd - offset > 1_024) throw new Error("invalid_chunked_response");
    const sizeToken = body.toString("ascii", offset, lineEnd).split(";", 1)[0]!.trim();
    if (!/^[0-9a-fA-F]{1,16}$/.test(sizeToken)) throw new Error("invalid_chunked_response");
    const size = Number.parseInt(sizeToken, 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid_chunked_response");
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks, length);
    if (length + size > maximum) throw new Error("wire_limit_exceeded");
    if (offset + size + 2 > body.length || body[offset + size] !== 13 || body[offset + size + 1] !== 10) {
      throw new Error("invalid_chunked_response");
    }
    chunks.push(body.subarray(offset, offset + size));
    length += size;
    offset += size + 2;
  }
}

export function parsePinnedHttpResponse(raw: Buffer, maximum: number): Omit<TransportResponse, "remoteAddress"> {
  const boundary = raw.indexOf("\r\n\r\n", 0, "ascii");
  if (boundary < 0 || boundary > MAX_HEADER_BYTES) throw new Error("invalid_http_response");
  const lines = raw.toString("latin1", 0, boundary).split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(lines.shift() ?? "");
  if (!statusMatch) throw new Error("invalid_http_response");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0 || /^[ \t]/.test(line)) throw new Error("invalid_http_response");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error("invalid_http_response");
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  const encodedBody = raw.subarray(boundary + 4);
  const transferEncoding = headers["transfer-encoding"]?.toLowerCase();
  let body: Buffer;
  if (transferEncoding !== undefined) {
    if (transferEncoding !== "chunked") throw new Error("unsupported_transfer_encoding");
    body = dechunk(encodedBody, maximum);
  } else if (headers["content-length"] !== undefined) {
    const value = headers["content-length"]!;
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid_http_response");
    const length = Number(value);
    if (!Number.isSafeInteger(length) || length > maximum) throw new Error("wire_limit_exceeded");
    if (encodedBody.length < length) throw new Error("incomplete_http_response");
    body = encodedBody.subarray(0, length);
  } else {
    if (encodedBody.length > maximum) throw new Error("wire_limit_exceeded");
    body = encodedBody;
  }
  return { status: Number(statusMatch[1]), headers, body };
}

export class NodeSafeFetchTransport implements SafeFetchTransport {
  request(input: TransportRequest): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let received = 0;
      let peerAddress = "";
      const socket = tls.connect({
        host: input.address,
        port: Number(input.url.port || 443),
        servername: input.url.hostname,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
      });
      const abort = () => finish(new Error("request_aborted"));
      const finish = (error?: Error, response?: TransportResponse) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", abort);
        socket.removeAllListeners();
        if (!socket.destroyed) socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      socket.setTimeout(input.timeoutMs);
      socket.once("secureConnect", () => {
        peerAddress = normalizeAddress(socket.remoteAddress);
        if (!peerAddress || !sameAddress(peerAddress, normalizeAddress(input.address)) || isIP(peerAddress) === 0) {
          finish(new Error("remote_address_mismatch"));
          return;
        }
        const headers = Object.entries(input.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
        socket.write(`GET ${input.url.pathname}${input.url.search} HTTP/1.1\r\nHost: ${input.url.hostname}\r\nConnection: close\r\n${headers}\r\n\r\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > input.maxWireBytes + MAX_HEADER_BYTES) {
          finish(new Error("wire_limit_exceeded"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      socket.once("end", () => {
        try {
          finish(undefined, { ...parsePinnedHttpResponse(Buffer.concat(chunks, received), input.maxWireBytes), remoteAddress: peerAddress });
        } catch (error) {
          finish(error instanceof Error ? error : new Error("invalid_http_response"));
        }
      });
      socket.once("close", (hadError) => {
        if (!settled && !hadError) finish(new Error("incomplete_http_response"));
      });
      socket.once("timeout", () => finish(new Error("request_timeout")));
      socket.once("error", (error) => finish(error));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
  }
}
