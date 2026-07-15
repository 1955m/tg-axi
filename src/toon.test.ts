import { describe, expect, it } from "vitest";
import {
  field,
  pluck,
  joinArray,
  lower,
  relativeTime,
  boolYesNo,
  custom,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  renderError,
  extract,
} from "./toon.js";

const MR = {
  iid: 7,
  title: "feat: add X",
  state: "OPENED",
  draft: false,
  labels: ["bug", "ui"],
  author: { username: "alice" },
  created_at: "2026-07-10T12:00:00Z",
};

describe("extract", () => {
  it("extracts field, pluck, lower, joinArray fields", () => {
    const out = extract(MR, [
      field("iid"),
      pluck("author", "username", "author"),
      lower("state"),
      joinArray("labels", "name", "labels"),
    ]);
    expect(out).toEqual({
      iid: 7,
      author: "alice",
      state: "opened",
      labels: "bug,ui",
    });
  });

  it("joinArray renders 'none' for empty arrays", () => {
    const out = extract({ ...MR, labels: [] }, [joinArray("labels", "name", "labels")]);
    expect(out.labels).toBe("none");
  });

  it("boolYesNo maps booleans", () => {
    expect(extract(MR, [boolYesNo("draft")]).draft).toBe("no");
    expect(extract({ ...MR, draft: true }, [boolYesNo("draft")]).draft).toBe("yes");
  });

  it("custom extractor runs the fn", () => {
    const out = extract(MR, [custom("id", (m) => `!${m.iid}`)]);
    expect(out.id).toBe("!7");
  });

  it("relativeTime formats a recent timestamp", () => {
    const out = extract(MR, [relativeTime("created_at", "created")]);
    expect(out.created).toMatch(/ago$/);
  });
});

describe("renderers", () => {
  it("renderList produces a labeled TOON block", () => {
    const out = renderList("mrs", [MR], [field("iid"), field("title")]);
    expect(out).toContain("mrs[1]");
    expect(out).toContain("7");
    expect(out).toContain("feat: add X");
  });

  it("renderDetail produces a single labeled object", () => {
    const out = renderDetail("mr", MR, [field("iid")]);
    expect(out).toContain("mr:");
    expect(out).toContain("iid: 7");
  });

  it("renderHelp formats a help[N] block", () => {
    const out = renderHelp(["do thing one", "do thing two"]);
    expect(out).toBe("help[2]:\n  do thing one\n  do thing two");
    expect(renderHelp([])).toBe("");
  });

  it("renderOutput joins non-empty blocks with newlines", () => {
    const out = renderOutput(["a", undefined, "b"]);
    expect(out).toBe("a\nb");
  });

  it("renderError includes code and suggestions", () => {
    const out = renderError("boom", "NOT_FOUND", ["retry"]);
    expect(out).toContain("error: boom");
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("help[1]");
  });
});
