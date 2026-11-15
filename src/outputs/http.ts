// JSON over HTTP for the output connectors (plain fetch, no SDKs).

export async function requestJson<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  a: { label: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'open-meeting-agent',
        ...(a.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...a.headers,
      },
      body: a.body !== undefined ? JSON.stringify(a.body) : undefined,
      signal: AbortSignal.timeout(a.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new Error(`${a.label}: ${(e as Error).message}`);
  }
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`${a.label}: HTTP ${r.status} ${errorText(json, text)}`);
  return (json ?? {}) as T;
}

function errorText(json: unknown, text: string): string {
  const j = json as { message?: unknown; errors?: unknown; errorMessages?: unknown; err?: unknown } | null;
  const parts = [j?.message, j?.err, j?.errorMessages, j?.errors].filter((x) => x != null);
  const s = parts.length ? parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') : text;
  return s.slice(0, 300);
}
