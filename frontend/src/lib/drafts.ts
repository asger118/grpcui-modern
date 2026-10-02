import type { MetadataPair } from "../api/types";

export interface MetadataRow {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
}

// Not crypto.randomUUID(): it is unavailable on plain-HTTP, non-localhost origins.
let nextId = 0;

export function newRow(pair: Partial<MetadataPair> = {}): MetadataRow {
  return { id: `row-${Date.now()}-${nextId++}`, enabled: true, name: pair.name ?? "", value: pair.value ?? "" };
}

/** Rows with a trailing blank row, so there is always somewhere to type. */
export function withBlankRow(rows: MetadataRow[]): MetadataRow[] {
  const last = rows[rows.length - 1];
  return last && !last.name && !last.value ? rows : [...rows, newRow()];
}

export function activeMetadata(rows: MetadataRow[]): MetadataPair[] {
  return rows
    .filter((r) => r.enabled && r.name.trim())
    .map((r) => ({ name: r.name.trim(), value: r.value }));
}

/**
 * Workspace state persisted per target: metadata and timeout are shared by
 * all methods (auth tokens etc.), request bodies are kept per method.
 */
export interface Workspace {
  metadata: MetadataRow[];
  timeoutSeconds: string;
  bodies: Record<string, string>;
}

const key = (target: string) => `grpcui:workspace:${target}`;

export function loadWorkspace(target: string, defaults: MetadataPair[]): Workspace {
  try {
    const raw = localStorage.getItem(key(target));
    if (raw) {
      const ws = JSON.parse(raw) as Workspace;
      return { ...ws, metadata: withBlankRow(ws.metadata ?? []) };
    }
  } catch {
    // corrupt or unavailable storage: fall through to defaults
  }
  return { metadata: withBlankRow(defaults.map(newRow)), timeoutSeconds: "", bodies: {} };
}

export function saveWorkspace(target: string, ws: Workspace) {
  try {
    localStorage.setItem(key(target), JSON.stringify(ws));
  } catch {
    // quota exceeded or storage disabled; persistence is best-effort
  }
}
