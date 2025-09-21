import fs from "node:fs/promises";
import JSON5 from "json5";
import { writeConfigFile, getConfigPath } from "./index";

export type KeyMetricsDelta = {
  req_count?: number; // typically +1
  req_tokens?: number; // input tokens to add
  rsp_tokens?: number; // output tokens to add
  err_code?: number | null; // set on error; clear on success if desired
  err_msg?: string | null; // set on error; clear on success if desired
  req_today?: number; // typically +1
  last_req_ts?: number; // seconds since epoch
};

// Helper to check if two unix timestamps (in seconds) are on the same calendar day in local time
const isSameDay = (ts1: number, ts2: number): boolean => {
  if (!ts1 || !ts2) return false;
  const d1 = new Date(ts1 * 1000);
  const d2 = new Date(ts2 * 1000);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
};

export async function updateKeyMetrics(
  providerName: string,
  usedKeyId: string,
  delta: KeyMetricsDelta
): Promise<void> {
  if (!providerName || !usedKeyId) return;
  // Read raw config (no env interpolation) to avoid overwriting placeholders
  const raw = await fs.readFile(getConfigPath(), "utf-8");
  const cfg: any = JSON5.parse(raw);

  const providers: any[] = (cfg.Providers || cfg.providers || []) as any[];
  const prov = providers.find(
    (p) => String(p?.name).toLowerCase() === String(providerName).toLowerCase()
  );
  if (!prov) return;

  if (!Array.isArray(prov.api_keys)) return; // only support when api_keys exists

  const findById = (entry: any) => {
    const name = entry?.name ? String(entry.name) : "";
    const key = entry?.key ? String(entry.key) : "";
    const last6 = key ? `...${key.slice(-6)}` : "";
    return usedKeyId === name || usedKeyId === last6;
  };

  const entry = prov.api_keys.find(findById);
  if (!entry) return; // do not create new key entry implicitly

  // Initialize fields if missing
  entry.req_count = Number(entry.req_count || 0);
  entry.req_tokens = Number(entry.req_tokens || 0);
  entry.rsp_tokens = Number(entry.rsp_tokens || 0);
  entry.req_today = Number(entry.req_today || 0);
  entry.last_req_ts = Number(entry.last_req_ts || 0);

  const now = Math.floor(Date.now() / 1000);
  if (!isSameDay(entry.last_req_ts, now)) {
    entry.req_today = 0;
  }
  entry.last_req_ts = now;

  if (typeof delta.req_count === "number") {
    entry.req_count += delta.req_count;
    entry.req_today += delta.req_count;
  }
  if (typeof delta.req_tokens === "number") entry.req_tokens += delta.req_tokens;
  if (typeof delta.rsp_tokens === "number") entry.rsp_tokens += delta.rsp_tokens;

  if (typeof delta.err_code !== "undefined") entry.err_code = delta.err_code;
  if (typeof delta.err_msg !== "undefined") {
    // Truncate very long messages to keep config readable
    const msg = delta.err_msg ?? "";
    entry.err_msg = typeof msg === "string" ? (msg.length > 500 ? msg.slice(0, 500) + "…" : msg) : msg;
  }

  await writeConfigFile(cfg);
}

