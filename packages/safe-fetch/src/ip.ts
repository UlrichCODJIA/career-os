import { isIP } from "node:net";

export type AddressFamily = 4 | 6;

export interface ParsedAddress {
  readonly address: string;
  readonly family: AddressFamily;
}

function ipv4Bytes(address: string): readonly number[] {
  return address.split(".").map(Number);
}

function ipv6Bytes(address: string): readonly number[] {
  const normalized = address.toLowerCase();
  const halves = normalized.split("::");
  const parseHalf = (value: string): number[] => {
    if (!value) return [];
    const output: number[] = [];
    for (const part of value.split(":")) {
      if (part.includes(".")) {
        const bytes = ipv4Bytes(part);
        output.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
      } else {
        output.push(Number.parseInt(part, 16));
      }
    }
    return output;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  const words = halves.length === 2
    ? [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right]
    : left;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

function prefixMatches(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  const complete = Math.floor(bits / 8);
  for (let index = 0; index < complete; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((bytes[complete] ?? 0) & mask) === ((prefix[complete] ?? 0) & mask);
}

const BLOCKED_V4: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

const BLOCKED_V6: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[32, 1, 0, 0], 32], // Teredo
  [[32, 1, 0, 2], 48], // benchmarking
  [[32, 1, 0, 16], 28], // ORCHID
  [[32, 1, 0, 32], 28], // ORCHIDv2
  [[32, 1, 0, 48], 28], // Drone Remote ID protocol
  [[32, 1, 13, 184], 32], // documentation
  [[32, 2], 16], // 6to4
  [[252], 7], // unique-local
  [[254, 128], 10], // link-local
  [[255], 8], // multicast
];

export function parseAddress(address: string): ParsedAddress | undefined {
  const family = isIP(address);
  if (family !== 4 && family !== 6) return undefined;
  return { address, family };
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return !BLOCKED_V4.some(([prefix, bits]) => prefixMatches(bytes, prefix, bits));
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    // Only globally routable unicast space is eligible, then carve out special-use ranges.
    if (!prefixMatches(bytes, [32], 3)) return false;
    return !BLOCKED_V6.some(([prefix, bits]) => prefixMatches(bytes, prefix, bits));
  }
  return false;
}

export function sameAddress(left: string, right: string): boolean {
  const leftFamily = isIP(left);
  const rightFamily = isIP(right);
  if (leftFamily !== rightFamily || leftFamily === 0) return false;
  const leftBytes = leftFamily === 4 ? ipv4Bytes(left) : ipv6Bytes(left);
  const rightBytes = rightFamily === 4 ? ipv4Bytes(right) : ipv6Bytes(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
}
