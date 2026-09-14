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

type JiebaModule = {
  default?: {
    cutForSearch?: (text: string, hmm?: boolean) => string[];
    cut?: (text: string, hmm?: boolean) => string[];
  };
  cutForSearch?: (text: string, hmm?: boolean) => string[];
  cut?: (text: string, hmm?: boolean) => string[];
};

let jiebaCutPromise: Promise<((text: string, hmm?: boolean) => string[]) | null> | null = null;
let jiebaCutUsable = true;

async function getJiebaCut(): Promise<((text: string, hmm?: boolean) => string[]) | null> {
  // nodejieba loads its native addon lazily, so a successful import() does not
  // prove the binding can be dlopen'd. Once a call fails we stop retrying and
  // permanently fall back to fallbackChineseTokens.
  if (!jiebaCutUsable) return null;
  jiebaCutPromise ??= import("nodejieba")
    .then(
      (module: JiebaModule) =>
        module.default?.cutForSearch ?? module.cutForSearch ?? module.default?.cut ?? module.cut ?? null,
    )
    .catch(() => null);
  return jiebaCutPromise;
}

function cutWithJiebaFallback(jiebaCut: ((text: string, hmm?: boolean) => string[]) | null, text: string): string[] {
  if (!jiebaCut) return fallbackChineseTokens(text);
  try {
    const tokens = jiebaCut(text, true);
    if (!Array.isArray(tokens)) throw new Error("nodejieba returned a non-array result");
    return tokens;
  } catch {
    jiebaCutUsable = false;
    return fallbackChineseTokens(text);
  }
}

function fallbackChineseTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0];
    tokens.push(run);
    // Chinese has no whitespace, so a whole run is one token and only exact
    // phrase matches hit. Emit bigrams (and lone chars) as subtokens to keep
    // partial queries searchable. normalizeForBm25 runs on both docs and
    // queries, so the extra subtokens stay symmetric and do not skew scoring.
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

async function normalizeForBm25(text: string): Promise<string> {
  if (!text.trim()) return "";
  if (!HAN_REGEX.test(text)) return text;

  const jiebaCut = await getJiebaCut();
  const rawTokens = cutWithJiebaFallback(jiebaCut, text);
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
      tokenizer: { language: "english" },
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

  const result = await search(prepared.db, {
    term: await normalizeForBm25(query),
    properties: ["content"],
    limit,
  });

  return result.hits.map((hit) => ({
    data: (hit.document as GenericBm25Doc<T>).data,
    score: hit.score,
  }));
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
      tokenizer: { language: "english" },
    },
  });

  await insertMultiple(db, docs);

  const result = await search(db, {
    term: await normalizeForBm25(query),
    properties: ["title", "tags", "description", "content"],
    limit,
    boost: {
      title: 3,
      tags: 2,
      description: 2,
      content: 1,
    },
  });

  return result.hits.map((hit) => ({
    path: (hit.document as Bm25Doc<Scope>).path,
    scope: (hit.document as Bm25Doc<Scope>).scope,
    score: hit.score,
  }));
}
