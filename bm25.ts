import fs from "node:fs";
import path from "node:path";
import { type AnyOrama, create, insertMultiple, search } from "@orama/orama";
import matter from "gray-matter";

type Bm25Doc<Scope extends string> = {
  id: string;
  path: string;
  scope: Scope;
  title: string;
  tags: string;
  description: string;
  content: string;
};

type GenericBm25Doc<T> = {
  id: string;
  content: string;
  data: T;
};

export type PreparedBm25Docs<T> = {
  db: AnyOrama;
  readonly __dataType?: T;
};

const HAN_REGEX = /\p{Script=Han}/u;

/**
 * Orama's tokenizer only knows English stopwords. Vietnamese is written with
 * space-separated syllables, so function words like "cách" or "không" otherwise
 * match nearly every document and a Vietnamese query returns the whole store.
 * Only function words belong here — domain nouns ("file", "biến", "tên", "số") stay.
 */
const VI_STOPWORDS = new Set([
  "ai",
  "bao",
  "bị",
  "bởi",
  "cả",
  "các",
  "cái",
  "cần",
  "cách",
  "chỉ",
  "cho",
  "chưa",
  "có",
  "còn",
  "của",
  "cũng",
  "do",
  "dưới",
  "đã",
  "đang",
  "để",
  "đến",
  "đều",
  "đó",
  "được",
  "đúng",
  "gì",
  "hay",
  "hơn",
  "hoặc",
  "khi",
  "không",
  "lại",
  "là",
  "làm",
  "lên",
  "lắm",
  "lúc",
  "mà",
  "một",
  "mỗi",
  "nào",
  "này",
  "nếu",
  "nên",
  "nhiều",
  "như",
  "nhưng",
  "những",
  "nữa",
  "phải",
  "quá",
  "ra",
  "rất",
  "rồi",
  "sẽ",
  "sao",
  "tại",
  "tất",
  "thì",
  "theo",
  "thế",
  "trong",
  "trên",
  "từ",
  "tới",
  "và",
  "vào",
  "vẫn",
  "về",
  "với",
  "vì",
  "xuống",
]);

const EN_STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "being",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "each",
  "few",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "might",
  "more",
  "most",
  "must",
  "of",
  "on",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "should",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "under",
  "up",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

// Hyphen/underscore/dot stay inside a token: they glue identifiers such as
// `pointer-events`, `fill-to-fill` or `manager_avatar_url` that a query searches by.
const TOKEN_SPLIT_REGEX = /[^\p{L}\p{N}_.-]+/u;

/**
 * Orama's default tokenizer splits on ASCII word boundaries, so every accented
 * letter acts as a separator: "đặt tên file biến" tokenizes to ["t","n","file","bi"]
 * and "số" to ["s"]. Those one-character fragments collide across every document,
 * which is why a query used to return the whole store with a flat score spread.
 * This tokenizer splits on Unicode boundaries and folds diacritics instead, so
 * "đặt tên" and "dat ten" both index as ["dat","ten"].
 */
const COMBINING_MARKS_REGEX = /\p{Mn}+/gu;

/** Fold accents onto ASCII: NFD strips combining marks, then đ is handled by hand. */
export function foldDiacritics(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS_REGEX, "")
    .replace(/\u0111/g, "d")
    .normalize("NFC");
}

const FOLDED_STOPWORDS = new Set([...VI_STOPWORDS, ...EN_STOPWORDS].map(foldDiacritics));
type MemoryTokenizer = {
  language: string;
  normalizationCache: Map<string, string>;
  tokenize: (raw: string) => string[];
};

export function createMemoryTokenizer(): MemoryTokenizer {
  return {
    language: "multilingual",
    normalizationCache: new Map(),
    tokenize(raw: string): string[] {
      const tokens: string[] = [];
      for (const piece of raw.split(TOKEN_SPLIT_REGEX)) {
        const token = foldDiacritics(piece);
        if (!token || FOLDED_STOPWORDS.has(token)) continue;
        tokens.push(token);
      }
      return tokens;
    },
  };
}

type JiebaModule = {
  default?: {
    cutForSearch?: (text: string, hmm?: boolean) => string[];
    cut?: (text: string, hmm?: boolean) => string[];
  };
  cutForSearch?: (text: string, hmm?: boolean) => string[];
  cut?: (text: string, hmm?: boolean) => string[];
};

let jiebaCutPromise: Promise<((text: string, hmm?: boolean) => string[]) | null> | null = null;

async function getJiebaCut(): Promise<((text: string, hmm?: boolean) => string[]) | null> {
  jiebaCutPromise ??= import("nodejieba")
    .then(
      (module: JiebaModule) =>
        module.default?.cutForSearch ?? module.cutForSearch ?? module.default?.cut ?? module.cut ?? null,
    )
    .catch(() => null);
  return jiebaCutPromise;
}

function fallbackChineseTokens(text: string): string[] {
  return [...text.matchAll(/\p{Script=Han}+/gu)].map((match) => match[0]);
}

export async function normalizeForBm25(text: string): Promise<string> {
  if (!text.trim()) return "";
  // Han text needs segmentation, which the tokenizer cannot do on its own. Every other
  // script is left as-is: createMemoryTokenizer splits it, folds diacritics and drops
  // stopwords, so doing any of that here as well would just be a second pass.
  if (!HAN_REGEX.test(text)) return text;

  const jiebaCut = await getJiebaCut();
  const rawTokens = jiebaCut?.(text, true) ?? fallbackChineseTokens(text);
  const tokens = rawTokens.map((token) => token.trim()).filter(Boolean);
  const encodedTokens = tokens.map((token) => `zh_${Buffer.from(token, "utf8").toString("hex")}`);
  return `${text} ${tokens.join(" ")} ${encodedTokens.join(" ")}`.trim();
}

export async function prepareBm25Docs<T>(
  docs: Array<{ id: string; content: string; data: T }>,
): Promise<PreparedBm25Docs<T> | null> {
  const normalizedDocs: Array<GenericBm25Doc<T>> = [];

  for (const doc of docs) {
    const content = await normalizeForBm25(doc.content);
    if (!content) continue;
    normalizedDocs.push({ ...doc, content });
  }

  if (normalizedDocs.length === 0) return null;

  const db = await create({
    schema: {
      id: "string",
      content: "string",
    },
    components: {
      tokenizer: createMemoryTokenizer() as never,
    },
  });

  await insertMultiple(db, normalizedDocs);
  return { db };
}

export async function searchPreparedBm25Docs<T>(
  prepared: PreparedBm25Docs<T> | null,
  query: string,
  limit = 20,
): Promise<Array<{ data: T; score: number }>> {
  if (!prepared) return [];

  const term = await normalizeForBm25(query);
  // An empty term must not fall through to Orama, which would score every document.
  if (!term) return [];

  const result = await search(prepared.db, {
    term,
    properties: ["content"],
    limit,
  });

  return result.hits.map((hit) => ({
    data: (hit.document as GenericBm25Doc<T>).data,
    score: hit.score,
  }));
}

/**
 * Fraction of the best hit's score a result must reach to be kept. Without a
 * floor, a query whose terms are all common words returns the entire store and
 * the tail looks as relevant as the head. "No strong match" is a useful answer.
 */
export const DEFAULT_MIN_SCORE_RATIO = 0.3;

export function applyMinScoreRatio<T extends { score: number }>(
  hits: T[],
  minScoreRatio = DEFAULT_MIN_SCORE_RATIO,
): T[] {
  if (hits.length <= 1 || minScoreRatio <= 0) return hits;
  const best = hits[0].score;
  if (!Number.isFinite(best) || best <= 0) return hits;
  const floor = best * minScoreRatio;
  const kept = hits.filter((hit) => hit.score >= floor);
  return kept.length > 0 ? kept : hits.slice(0, 1);
}

export async function bm25SearchDocs<T>(
  docs: Array<{ id: string; content: string; data: T }>,
  query: string,
  limit = 20,
): Promise<Array<{ data: T; score: number }>> {
  return searchPreparedBm25Docs(await prepareBm25Docs(docs), query, limit);
}

export async function bm25SearchMemoryFiles<Scope extends string>(
  filePaths: Array<{ filePath: string; scope: Scope }>,
  query: string,
  limit = 20,
  options: { minScoreRatio?: number } = {},
): Promise<Array<{ path: string; scope: Scope; score: number }>> {
  const docs: Bm25Doc<Scope>[] = [];

  for (const item of filePaths) {
    const raw = await fs.promises.readFile(item.filePath, "utf-8").catch(() => "");
    if (!raw) continue;
    const parsed = matter(raw);
    docs.push({
      id: item.filePath,
      path: item.filePath,
      scope: item.scope,
      title: await normalizeForBm25(path.basename(item.filePath, ".md")),
      tags: await normalizeForBm25(Array.isArray(parsed.data.tags) ? parsed.data.tags.join(" ") : ""),
      description: await normalizeForBm25(typeof parsed.data.description === "string" ? parsed.data.description : ""),
      content: await normalizeForBm25(parsed.content),
    });
  }

  if (docs.length === 0) return [];

  const db = await create({
    schema: {
      id: "string",
      path: "string",
      scope: "string",
      title: "string",
      tags: "string",
      description: "string",
      content: "string",
    },
    components: {
      tokenizer: createMemoryTokenizer() as never,
    },
  });

  await insertMultiple(db, docs);

  const term = await normalizeForBm25(query);
  if (!term) return [];

  const result = await search(db, {
    term,
    properties: ["title", "tags", "description", "content"],
    limit,
    boost: {
      title: 3,
      tags: 2,
      description: 2,
      content: 1,
    },
  });

  return applyMinScoreRatio(
    result.hits.map((hit) => ({
      path: (hit.document as Bm25Doc<Scope>).path,
      scope: (hit.document as Bm25Doc<Scope>).scope,
      score: hit.score,
    })),
    options.minScoreRatio,
  );
}
