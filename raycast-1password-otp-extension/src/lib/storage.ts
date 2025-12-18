import { LocalStorage, getPreferenceValues } from "@raycast/api";
import { randomUUID } from "crypto";

export type OtpPair = {
  id: string;
  label: string;
  ref: string;
};

const STORAGE_KEY = "otp_pairs";

type Prefs = {
  otp_pairs_seed?: string;
};

export async function loadPairs(): Promise<OtpPair[]> {
  const raw = await LocalStorage.getItem<string>(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as OtpPair[];
      return parsed.filter((p) => p && p.label && p.ref && p.id);
    } catch {
      return [];
    }
  }
  const prefs = getPreferenceValues<Prefs>();
  const seed = prefs.otp_pairs_seed?.trim();
  if (!seed) return [];
  const seeded = parseSeed(seed);
  if (seeded.length > 0) {
    await savePairs(seeded);
    return seeded;
  }
  return [];
}

export async function savePairs(pairs: OtpPair[]): Promise<void> {
  const normalized = pairs.map((p) => ({ id: p.id || generateId(), label: p.label.trim(), ref: p.ref.trim() }));
  await LocalStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export async function addPair(label: string, ref: string): Promise<OtpPair> {
  const pairs = await loadPairs();
  const pair: OtpPair = { id: generateId(), label: label.trim(), ref: ref.trim() };
  pairs.push(pair);
  await savePairs(pairs);
  return pair;
}

export async function updatePair(updated: OtpPair): Promise<void> {
  const pairs = await loadPairs();
  const idx = pairs.findIndex((p) => p.id === updated.id);
  if (idx >= 0) {
    pairs[idx] = { ...updated, label: updated.label.trim(), ref: updated.ref.trim() };
    await savePairs(pairs);
  }
}

export async function deletePair(id: string): Promise<void> {
  const pairs = await loadPairs();
  const filtered = pairs.filter((p) => p.id !== id);
  await savePairs(filtered);
}

export function exportPairsJSON(pairs: OtpPair[]): string {
  const minimal = pairs.map((p) => ({ label: p.label, ref: p.ref }));
  return JSON.stringify(minimal, null, 2);
}

export function parseSeed(text: string): OtpPair[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const arr = JSON.parse(trimmed) as Array<{ label?: string; ref?: string }>;
    if (Array.isArray(arr)) {
      const pairs = arr
        .filter((x) => x && typeof x.label === "string" && typeof x.ref === "string")
        .map((x) => ({ id: generateId(), label: x.label!.trim(), ref: x.ref!.trim() }))
        .filter((p) => p.label && p.ref);
      if (pairs.length > 0) return pairs;
    }
  } catch {}
  const lines = trimmed.split(/\r?\n/);
  const pairs: OtpPair[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(.+?)\s*=\s*(op:\/\/.*)\s*$/);
    if (m) {
      const label = m[1].trim();
      const ref = m[2].trim();
      if (label && ref) pairs.push({ id: generateId(), label, ref });
    }
  }
  return dedupeByLabel(pairs);
}

export function mergePairs(existing: OtpPair[], incoming: OtpPair[]): OtpPair[] {
  const byLabel = new Map(existing.map((p) => [p.label.toLowerCase(), p] as const));
  for (const p of incoming) {
    const key = p.label.toLowerCase();
    if (byLabel.has(key)) {
      const cur = byLabel.get(key)!;
      byLabel.set(key, { ...cur, ref: p.ref });
    } else {
      byLabel.set(key, p);
    }
  }
  return Array.from(byLabel.values());
}

function dedupeByLabel(pairs: OtpPair[]): OtpPair[] {
  const seen = new Set<string>();
  const out: OtpPair[] = [];
  for (const p of pairs) {
    const key = p.label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function generateId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
}
