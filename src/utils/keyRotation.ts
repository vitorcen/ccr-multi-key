// Key rotation and disabling utilities for providers
// Encapsulates in-memory state and decision helpers used by the router

export interface ApiKeyEntry {
  name?: string;
  key?: string;
}

export interface ProviderLike {
  name: string;
  api_keys: ApiKeyEntry[];
}

// In-memory rotation index per provider
const providerKeyIndex = new Map<string, number>();
// In-memory disabled key IDs per provider
const disabledApiKeys = new Map<string, Set<string>>();

export const getKeyId = (entry?: ApiKeyEntry): string => {
  if (!entry) return "unknown";
  if (entry.name && entry.name.trim()) return String(entry.name);
  if (entry.key) return `...${String(entry.key).slice(-6)}`;
  return "unknown";
};

export function selectKeyForProvider(provider: ProviderLike): {
  selected: ApiKeyEntry;
  chosenIndex: number;
  total: number;
  usedKeyId: string;
  allDisabled: boolean;
} {
  const total = Array.isArray(provider.api_keys) ? provider.api_keys.length : 0;
  if (total === 0) {
    return { selected: {}, chosenIndex: 0, total: 0, usedKeyId: "unknown", allDisabled: true };
  }
  const provName = provider.name;
  const startIdx = providerKeyIndex.get(provName) ?? 0;
  const disabled = disabledApiKeys.get(provName) ?? new Set<string>();
  if (!disabledApiKeys.has(provName)) disabledApiKeys.set(provName, disabled);

  let chosenIndex = -1;
  for (let i = 0; i < total; i++) {
    const cand = provider.api_keys[(startIdx + i) % total];
    const candId = getKeyId(cand);
    if (!disabled.has(candId)) {
      chosenIndex = (startIdx + i) % total;
      break;
    }
  }
  const index = (chosenIndex >= 0 ? chosenIndex : startIdx) % total;
  const selected = provider.api_keys[index];
  const usedKeyId = getKeyId(selected);
  const allDisabled = chosenIndex < 0;
  return { selected, chosenIndex: index, total, usedKeyId, allDisabled };
}

export function findKeyIndexById(provider: ProviderLike, usedKeyId: string): number {
  const total = Array.isArray(provider.api_keys) ? provider.api_keys.length : 0;
  if (total === 0) return -1;
  for (let i = 0; i < total; i++) {
    const cand = provider.api_keys[i];
    if (getKeyId(cand) === usedKeyId) return i;
  }
  return -1;
}

export function advanceOnSuccess(providerName: string, chosenIndex: number, total: number) {
  if (!providerName || !Number.isInteger(chosenIndex) || !Number.isInteger(total) || total <= 0) return;
  providerKeyIndex.set(providerName, ((chosenIndex as number) + 1) % (total as number));
}

export function markKeyDisabled(providerName: string, keyId: string) {
  if (!providerName || !keyId) return;
  const set = disabledApiKeys.get(providerName) ?? new Set<string>();
  set.add(String(keyId));
  disabledApiKeys.set(providerName, set);
}

export function shouldDisableForStatus(status?: number): boolean {
  if (typeof status !== 'number') return false;
  // Simplified policy: allow 429 (rate limits); for any other 4xx, disable the key
  return status >= 400 && status < 500 && status !== 429;
}

