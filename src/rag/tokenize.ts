// Pure text -> tokens, shared by the BM25 index (documents) and the BM25 query. No DOM,
// no IndexedDB. An identifier like pool_pre_ping is emitted whole AND as its parts
// (pool, pre, ping), so an exact identifier is the strongest match but prose that only
// says "pre-ping" is still found.

// Hashes, base64 blobs and pasted keys: never useful to match on, and they bloat the maps.
export const MAX_TOKEN_LENGTH = 40;

const RAW_TOKEN = /[\p{L}\p{N}_]+/gu;

// True when splitParts() below would find anything to split: an underscore, a lower/digit
// followed by an upper (getUser, base64E), or an acronym followed by a word (HTTPServer).
// Must stay in step with the two replace() rules in splitParts.
const NEEDS_SPLIT = /_|(?:\p{Ll}|\p{N})\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u;

// Applied to the query only. Documents keep every token, so `not`, `in` and `is` stay
// findable in code, and IDF already gives common words almost no weight.
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your',
]);

function splitParts(raw: string): string[] {
  return raw
    .split(/_+/u)
    .filter((segment) => segment.length > 0)
    .flatMap((segment) =>
      segment
        .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2') // getUser -> get User, base64E -> base64 E
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2') // HTTPServer -> HTTP Server
        .split(' '),
    )
    .map((part) => part.toLowerCase());
}

/** Every token of `text`, duplicates kept (callers count them), in order. No stopword removal. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(RAW_TOKEN)) {
    const raw = match[0];
    if (raw.length > MAX_TOKEN_LENGTH) continue;
    // Most tokens are plain words with no split point; skip the splitting work for them.
    if (!NEEDS_SPLIT.test(raw)) {
      tokens.push(raw.toLowerCase());
      continue;
    }
    const parts = splitParts(raw);
    if (parts.length === 0) continue; // nothing but underscores
    const whole = raw.toLowerCase();
    if (parts.length > 1 || whole !== parts[0]) tokens.push(whole);
    tokens.push(...parts);
  }
  return tokens;
}

/** The unique tokens of a search query, first-seen order, minus stopwords. */
export function tokenizeQuery(text: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    if (!QUERY_STOPWORDS.has(token)) seen.add(token);
  }
  return [...seen];
}
