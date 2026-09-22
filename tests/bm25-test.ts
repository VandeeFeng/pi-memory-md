import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyMinScoreRatio,
  bm25SearchMemoryFiles,
  createMemoryTokenizer,
  foldDiacritics,
  normalizeForBm25,
} from "../bm25.js";
import { createTempDir, writeText } from "./test-helpers.js";

describe("normalizeForBm25", () => {
  it("leaves non-Han text to the tokenizer", async () => {
    // Stopwords and diacritics are the tokenizer's job now; this step only segments Han.
    assert.equal(await normalizeForBm25("của dialog shell"), "của dialog shell");
    assert.deepEqual(createMemoryTokenizer().tokenize(await normalizeForBm25("của dialog shell")), ["dialog", "shell"]);
  });

  it("keeps the Han path intact by emitting indexed tokens", async () => {
    const normalized = await normalizeForBm25("中文测试");
    assert.ok(normalized.includes("zh_"), normalized);
    assert.ok(normalized.includes("中文测试"));
  });
});

describe("applyMinScoreRatio", () => {
  it("keeps only hits within the ratio of the best score", () => {
    const hits = [{ score: 10 }, { score: 4 }, { score: 2 }];
    assert.deepEqual(applyMinScoreRatio(hits, 0.3), [{ score: 10 }, { score: 4 }]);
  });

  it("never drops everything when all hits fall below the floor", () => {
    const hits = [{ score: 1 }, { score: 0.5 }];
    assert.deepEqual(applyMinScoreRatio(hits, 2), [{ score: 1 }]);
  });

  it("is a no-op for a single hit, a disabled ratio, or non-positive scores", () => {
    const single = [{ score: 1 }];
    assert.equal(applyMinScoreRatio(single, 0.9), single);
    const hits = [{ score: 5 }, { score: 1 }];
    assert.equal(applyMinScoreRatio(hits, 0), hits);
    assert.equal(applyMinScoreRatio([{ score: 0 }, { score: 0 }], 0.5)[0].score, 0);
  });
});

describe("bm25SearchMemoryFiles", () => {
  function writeMemoryFile(dir: string, name: string, description: string, body: string): string {
    const filePath = path.join(dir, name);
    writeText(filePath, `---\ndescription: ${description}\ntags: [test]\n---\n\n${body}\n`);
    return filePath;
  }

  it("ranks the discriminating document first and trims the undiscriminating tail", async () => {
    const dir = createTempDir("bm25-precision");
    const naming = writeMemoryFile(
      dir,
      "naming.md",
      "Quy ước đặt tên file và biến, không mang số issue vào identifier",
      "Không dùng issue396 làm tên biến hay tên file.",
    );
    const figma = writeMemoryFile(
      dir,
      "figma.md",
      "Số đo avatar trong Figma và viền màu theo vai trò",
      "Cách đo khoảng cách giữa hai card cho đúng.",
    );
    const devstack = writeMemoryFile(
      dir,
      "devstack.md",
      "Recipe dựng stack dev trên cổng riêng, không đụng stack của user",
      "Cách chạy API và web ở cổng riêng.",
    );

    const files = [naming, figma, devstack].map((filePath) => ({ filePath, scope: "project" as const }));
    const hits = await bm25SearchMemoryFiles(files, "cách đặt tên file biến không mang số issue", 20);

    assert.ok(hits.length > 0, "expected at least one hit");
    assert.ok(hits.length < files.length, `expected the tail to be trimmed, got ${hits.length} hits`);
    assert.equal(hits[0].path, naming);
    assert.ok(!hits.some((hit) => hit.path === devstack), "unrelated document should not survive the floor");
  });

  it("returns no hits when the query is only function words", async () => {
    const dir = createTempDir("bm25-stopwords-only");
    const filePath = writeMemoryFile(dir, "any.md", "Tài liệu bất kỳ", "nội dung bất kỳ");
    const hits = await bm25SearchMemoryFiles([{ filePath, scope: "project" as const }], "và của cho với", 20);
    assert.deepEqual(hits, []);
  });
});

describe("createMemoryTokenizer", () => {
  it("keeps accented words whole instead of shredding them on ASCII boundaries", () => {
    const tokenizer = createMemoryTokenizer();
    assert.deepEqual(tokenizer.tokenize("đặt tên file biến"), ["dat", "ten", "file", "bien"]);
    assert.deepEqual(tokenizer.tokenize("viền"), ["vien"]);
    assert.deepEqual(tokenizer.tokenize("số"), ["so"]);
    // Orama's own tokenizer returns ["s"] here, which used to match every document.
    assert.equal(tokenizer.tokenize("số").length, 1);
  });

  it("drops English and Vietnamese stopwords after folding", () => {
    const tokenizer = createMemoryTokenizer();
    assert.deepEqual(tokenizer.tokenize("cách đặt tên của file"), ["dat", "ten", "file"]);
    assert.deepEqual(tokenizer.tokenize("the name of the file"), ["name", "file"]);
  });

  it("keeps identifiers and Han tokens intact", () => {
    const tokenizer = createMemoryTokenizer();
    assert.deepEqual(tokenizer.tokenize("pointer-events manager_avatar_url"), ["pointer-events", "manager_avatar_url"]);
    const han = tokenizer.tokenize("中文 zh_5e2f");
    assert.ok(han.includes("中文"), JSON.stringify(han));
    assert.ok(han.includes("zh_5e2f"), JSON.stringify(han));
  });
});

describe("accent-insensitive search", () => {
  function writeNote(dir: string, name: string, description: string, body: string): string {
    const filePath = path.join(dir, name);
    writeText(filePath, `---\ndescription: ${description}\ntags: [t]\n---\n\n${body}\n`);
    return filePath;
  }

  it("finds an accented document from an unaccented query", async () => {
    const dir = createTempDir("bm25-fold-query");
    const naming = writeNote(dir, "naming.md", "Quy ước đặt tên file", "Không dùng issue396 làm tên biến.");
    const other = writeNote(dir, "other.md", "Số đo avatar", "Đo khoảng cách giữa hai card.");
    const files = [naming, other].map((filePath) => ({ filePath, scope: "project" as const }));

    const hits = await bm25SearchMemoryFiles(files, "dat ten file", 20);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, naming);
  });

  it("stops a bare syllable from matching unrelated documents", async () => {
    const dir = createTempDir("bm25-syllable");
    const withSo = writeNote(dir, "with-so.md", "Số issue trong tên", "Mang số issue vào tên file.");
    const withoutSo = writeNote(dir, "without.md", "Avatar provider", "Viền gradient theo vai trò.");
    const files = [withSo, withoutSo].map((filePath) => ({ filePath, scope: "project" as const }));

    const hits = await bm25SearchMemoryFiles(files, "số issue", 20);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].path, withSo);
    assert.ok(!hits.some((hit) => hit.path === withoutSo), "syllable fragments must not match unrelated docs");
  });
});

describe("foldDiacritics", () => {
  it("folds Vietnamese accents and đ onto ASCII", () => {
    assert.equal(foldDiacritics("đặt"), "dat");
    assert.equal(foldDiacritics("TÊN"), "ten");
    assert.equal(foldDiacritics("ĐƯỜNG"), "duong");
    assert.equal(foldDiacritics("pointer-events"), "pointer-events");
  });
});
