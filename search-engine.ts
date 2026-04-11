/**
 * Search engine for memory files.
 * Regex support, stopword filtering, line-based snippets.
 * Regex support, stopword filtering, multi-term OR matching, line-based snippets.
 */

import type { MemoryFile } from "./types.js";

// ── Types ──

export interface SearchHit {
  path: string;
  snippet: string;
  matchCount: number;
  matchedIn: Array<"content" | "tags" | "description">;
}

export type SearchField = "content" | "tags" | "description" | "all";

// ── Regex utilities ──

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const safeRegex = (pattern: string): RegExp => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

const looksLikeRegex = (query: string): boolean => /[|*+?{}()[\]\\^$.]/.test(query);

const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => {
    try {
      new RegExp(t, "i");
      return t;
    } catch {
      return escapeRegex(t);
    }
  });
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords ──

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
]);

const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  return meaningful.length > 0 ? meaningful : terms;
};

// ── Helpers ──

const countMatches = (hay: string, terms: string[]): number => {
  let count = 0;
  for (const t of terms) {
    if (safeRegex(t).test(hay)) count++;
  }
  return count;
};

const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return lines[0]?.substring(0, 100) ?? "";

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

function buildSearchText(memory: MemoryFile, field: SearchField): string {
  switch (field) {
    case "content":
      return memory.content;
    case "tags":
      return memory.frontmatter.tags?.join(" ") ?? "";
    case "description":
      return memory.frontmatter.description;
    case "all":
      return [memory.frontmatter.description, memory.frontmatter.tags?.join(" ") ?? "", memory.content].join("\n");
  }
}

function detectMatchedFields(memory: MemoryFile, regex: RegExp): Array<"content" | "tags" | "description"> {
  const fields: Array<"content" | "tags" | "description"> = [];
  if (regex.test(memory.content)) fields.push("content");
  if (memory.frontmatter.tags?.some((t) => regex.test(t))) fields.push("tags");
  if (regex.test(memory.frontmatter.description)) fields.push("description");
  return fields;
}

function buildSnippet(memory: MemoryFile, searchIn: SearchField, regex: RegExp): string {
  if (searchIn === "tags") return `Tags: ${memory.frontmatter.tags?.join(", ") ?? ""}`;
  const text = searchIn === "description" ? memory.frontmatter.description : memory.content;
  return lineSnippet(text, regex);
}

// ── Main search function ──

export interface SearchInput {
  files: Map<string, MemoryFile>;
  query: string;
  searchIn: SearchField;
}

export function searchMemoryFiles(input: SearchInput): SearchHit[] {
  const { files, query, searchIn } = input;
  const rawQuery = query.trim();
  if (!rawQuery) return [];

  const entries = Array.from(files.entries());

  // Regex mode: query contains metacharacters
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];

    for (const [relPath, memory] of entries) {
      const text = buildSearchText(memory, searchIn);
      if (!regex.test(text)) continue;

      hits.push({
        path: relPath,
        snippet: buildSnippet(memory, searchIn, regex),
        matchCount: 1,
        matchedIn: detectMatchedFields(memory, regex),
      });
    }

    return hits;
  }

  // Natural language mode: OR match, sorted by matchCount desc
  const terms = filterStopwords(rawQuery.split(/\s+/));
  const snipRe = snippetRegex(terms);

  const hits: Array<{ hit: SearchHit; mc: number }> = [];
  for (const [relPath, memory] of entries) {
    const text = buildSearchText(memory, searchIn);
    const mc = countMatches(text, terms);
    if (mc === 0) continue;

    hits.push({
      hit: {
        path: relPath,
        snippet: buildSnippet(memory, searchIn, snipRe),
        matchCount: mc,
        matchedIn: detectMatchedFields(memory, snipRe),
      },
      mc,
    });
  }

  hits.sort((a, b) => b.mc - a.mc);
  return hits.map((h) => h.hit);
}
