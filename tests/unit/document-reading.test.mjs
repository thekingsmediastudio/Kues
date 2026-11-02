import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDocument,
  FILE_TEXT,
} from "../../apps/web/lib/ai-agent/file-formats.mjs";
import { createFileTools } from "../../apps/web/lib/ai-agent/file-tools.mjs";
import {
  planDocumentContext,
  reviewDocumentContext,
  documentCoverageMarkdown,
} from "../../apps/web/lib/ai-agent/document-reading.mjs";
function pdf(count, blank = []) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 1; i <= count; i++) {
    const text = blank.includes(i)
      ? ""
      : `Page ${i}. ` +
        (i === count
          ? "FINAL VERDICT: the amber lantern is returned. "
          : "The village prepares its annual gathering. ") +
        "Evidence and dialogue in this chapter. ".repeat(12);
    const stream =
      `BT /F1 10 Tf 30 750 Td 13 TL ` +
      (text.match(/.{1,75}/g) || [""])
        .map((line) => `(${line}) Tj T*`)
        .join(" ") +
      " ET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (i - 1) * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((x, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${x}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((x) => String(x).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}
const agent = { id: "a", settings: { toolPermissions: { read_files: true } } };
const scope = { userId: "u", workspaceId: "w", agent };
let document;
test("real PDF extraction reaches page 74, not just the opening 8000 characters", async () => {
  document = await parseDocument(pdf(74), "long.pdf");
  assert.equal(document.totalPages, 74);
  assert.equal(document.sections.length, 74);
  assert(document.text.length > 8000);
  assert.match(document.text, /amber lantern/);
  assert.equal(document.truncated, false);
});
test("whole summary plans every section while targeted question retrieves late evidence with page labels", async () => {
  const f = { ...(await parseDocument(pdf(74), "long.pdf")), name: "long.pdf" };
  const whole = planDocumentContext([f], "Summarise the entire play");
  assert(whole.reviewBatches.length > 1);
  assert.equal(whole.reviewBatches.flat().length, 74);
  const targeted = planDocumentContext(
    [f],
    "What happens to the amber lantern?",
  );
  assert(!targeted.reviewBatches);
  assert.match(targeted.files[0].text, /Page 74/);
  assert.match(targeted.files[0].text, /amber lantern/);
  assert(targeted.files[0].coverage.selectedSections < 74);
  assert.match(documentCoverageMarkdown(targeted), /not a full review/);
});
test("explicit page range and unreadable pages do not claim whole review", async () => {
  const f = {
    ...(await parseDocument(pdf(74, [10, 31]), "long.pdf")),
    name: "long.pdf",
  };
  assert.deepEqual(f.missingPages, [10, 31]);
  const result = planDocumentContext([f], "Review pages 70-74");
  assert(!result.reviewBatches);
  assert.equal(result.files[0].coverage.selectedSections, 5);
  assert(!result.files[0].text.includes("[Page 1]"));
  assert.match(documentCoverageMarkdown(result), /10, 31/);
  const absent = planDocumentContext([f], "Read page 900");
  assert.equal(absent.files[0].text, "");
});
test("extraction ceilings are explicit and indexed text is reused without reparsing", async () => {
  let calls = 0;
  const service = createFileTools({
    parse: async (...a) => {
      calls++;
      return parseDocument(...a);
    },
  });
  const uploaded = await service.add({
    ...scope,
    bytes: Buffer.from("A".repeat(FILE_TEXT + 9000)),
    name: "long.txt",
  });
  assert(uploaded.truncated);
  assert.equal(uploaded.characters, FILE_TEXT);
  service.context({
    ...scope,
    ids: [uploaded.id],
    query: "Summarise this document",
  });
  service.context({ ...scope, ids: [uploaded.id], query: "Find a fact" });
  assert.equal(calls, 1);
});
function harness(context, overrides = {}) {
  const ledger = [],
    calls = [],
    stages = [];
  return {
    ledger,
    calls,
    stages,
    options: {
      context,
      agent,
      authorize: async () => {},
      reserve: async (k, n) => ledger.push(["reserve", k, n]),
      settle: async (k, r) => ledger.push(["settle", k, r.inputTokens]),
      release: async (k) => ledger.push(["release", k]),
      call: async (input) => {
        calls.push(input);
        return {
          text:
            "Evidence notes: " +
            input.fileContext.files.map((f) => f.text.slice(0, 70)).join(" "),
          provider: "mock",
          model: "mock",
          inputTokens: 20,
          outputTokens: 10,
        };
      },
      onStage: async (s) => stages.push(s),
      ...overrides,
    },
  };
}
test("section pass budgets each call and returns bounded notes with complete extracted coverage", async () => {
  const f = { ...(await parseDocument(pdf(74), "long.pdf")), name: "long.pdf" },
    context = planDocumentContext([f], "Summarise this document");
  const h = harness(context);
  const result = await reviewDocumentContext(h.options);
  assert.equal(result.files[0].coverage.selectedSections, 74);
  assert.equal(result.files[0].coverage.mode, "section_notes");
  assert.equal(h.calls.length, context.reviewBatches.length);
  assert(h.calls.every((c) => c.workspaceTools === false));
  assert.equal(
    h.ledger.filter((x) => x[0] === "settle").length,
    h.calls.length,
  );
  assert.equal(h.stages.at(-1).completed, h.calls.length);
  assert(JSON.stringify(result).length < 38000);
});
test("cancellation stops further calls and settles partial usage", async () => {
  const f = { ...(await parseDocument(pdf(74), "long.pdf")), name: "long.pdf" },
    context = planDocumentContext([f], "Summarise this document");
  const controller = new AbortController();
  const h = harness(context, {
    signal: controller.signal,
    call: async () => {
      controller.abort();
      const e = new Error("canceled");
      e.partialCompletion = {
        provider: "mock",
        model: "mock",
        inputTokens: 11,
        outputTokens: 2,
      };
      throw e;
    },
  });
  await assert.rejects(reviewDocumentContext(h.options));
  assert.equal(h.ledger.filter((x) => x[0] === "reserve").length, 1);
  assert.equal(h.ledger.filter((x) => x[0] === "settle")[0][2], 11);
});
test("revoked permission prevents a section call and releases its unused reservation", async () => {
  const context = planDocumentContext(
    [
      {
        name: "long.txt",
        format: "txt",
        text: "x".repeat(30000),
        sections: [
          { id: 1, label: "part", text: "x".repeat(15000) },
          { id: 2, label: "end", text: "y".repeat(15000) },
        ],
      },
    ],
    "Summarise this document",
  );
  let checks = 0;
  const h = harness(context, {
    authorize: async () => {
      if (++checks === 2) throw Error("permission_revoked");
    },
  });
  await assert.rejects(reviewDocumentContext(h.options), /permission_revoked/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ledger.at(-1)[0], "release");
});
test("files never share a note batch and oversized reviews are refused before provider calls", () => {
  const f = (n) => ({
    name: n,
    format: "txt",
    text: "a".repeat(240000),
    sections: Array.from({ length: 80 }, (_, i) => ({
      id: i + 1,
      label: "part" + i,
      text: "a".repeat(3000),
    })),
  });
  const context = planDocumentContext(
    [
      {
        ...f("one"),
        text: "a".repeat(20000),
        sections: f("one").sections.slice(0, 7),
      },
      {
        ...f("two"),
        text: "a".repeat(20000),
        sections: f("two").sections.slice(0, 7),
      },
    ],
    "Summarise both",
  );
  assert(
    context.reviewBatches.every(
      (batch) => new Set(batch.map((x) => x.fileIndex)).size === 1,
    ),
  );
  assert.throws(
    () =>
      planDocumentContext(
        [f("one"), f("two"), f("three")],
        "Summarise everything",
      ),
    (e) => e.code === "file_review_limit",
  );
});
export { pdf };
