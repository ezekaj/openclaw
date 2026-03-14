export async function fetchMinimaxUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "MM-API-Source": "OpenClaw",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider: "minimax",
      displayName: "Minimax",
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (!isRecord(data)) {
    return {
      provider: "minimax",
      displayName: "Minimax",
      windows: [],
      error: "Invalid JSON",
    };
  }

  if (typeof data.status_code === "number" && data.status_code !== 0) {
    return {
      provider: "minimax",
      displayName: "Minimax",
      windows: [],
      error: (data.status_msg as string | undefined)?.trim() || "API error",
    };
  }

  const candidates = collectUsageCandidates(data);
  let usageRecord: Record<string, unknown> = data;
  let usedPercent: number | null = null;
  for (const candidate of candidates) {
    const candidatePercent = deriveUsedPercent(candidate);
    if (candidatePercent !== null) {
      usageRecord = candidate;
      usedPercent = candidatePercent;
      break;
    }
  }
  if (usedPercent === null) {
    usedPercent = deriveUsedPercent(data);
  }
  if (usedPercent === null) {
    return {
      provider: "minimax",
      displayName: "Minimax",
      windows: [],
      error: "Unsupported response shape",
    };
  }

  const resetAt =
    parseEpoch(pickString(usageRecord, RESET_KEYS)) ??
    parseEpoch(pickNumber(usageRecord, RESET_KEYS)) ??
    parseEpoch(pickString(data, RESET_KEYS)) ??
    parseEpoch(pickNumber(data, RESET_KEYS));
  const windows: UsageWindow[] = [
    {
      label: deriveWindowLabel(usageRecord),
      usedPercent,
      resetAt,
    },
  ];

  return {
    provider: "minimax",
    displayName: "Minimax",
    windows,
    plan: pickString(usageRecord, PLAN_KEYS) ?? pickString(data, PLAN_KEYS),
  };
}