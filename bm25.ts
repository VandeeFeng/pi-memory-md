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

async function normalizeForBm25(text: string): Promise<string> {
  if (!text.trim()) return "";
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
