import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, type Dispatcher } from "undici";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export class SsrFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrFBlockedError";
  }
}

export type LookupFn = typeof dnsLookup;

export type SsrFPolicy = {
  allowPrivateNetwork?: boolean;
  allowedHostnames?: string[];
};

const PRIVATE_IPV6_PREFIXES = ["fe80:", "fec0:", "fc", "fd"];
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function normalizeHostnameSet(values?: string[]): Set<string> {
  if (!values || values.length === 0) {
    return new Set<string>();
  }
  return new Set(values.map(normalizeHostname));
}