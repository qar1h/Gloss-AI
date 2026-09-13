// sha256 hex digest, truncated to 16 hex chars (64 bits) — enough to detect content
// changes for incremental indexing. Not used for anything security-sensitive.

export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
