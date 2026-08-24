import { describe, expect, it } from "vitest";
import { isUnsupportedBinaryContentType } from "@/server/services/url-safety";

describe("isUnsupportedBinaryContentType", () => {
  it(
    "real regression: a restaurant's 'menu' link resolving to a photographed menu " +
      '(live-observed: a real Prague restaurant\'s "poledni-menu" link was Content-Type: ' +
      "image/jpeg, a genuine photo of their weekly menu — no OCR anywhere in this pipeline) " +
      "must be rejected, not UTF-8-decoded as if it were text",
    () => {
      expect(isUnsupportedBinaryContentType("image/jpeg")).toBe(true);
    }
  );

  it("flags other image/video/audio content types regardless of subtype", () => {
    expect(isUnsupportedBinaryContentType("image/png")).toBe(true);
    expect(isUnsupportedBinaryContentType("video/mp4")).toBe(true);
    expect(isUnsupportedBinaryContentType("audio/mpeg")).toBe(true);
  });

  it("flags generic binary/zip content types", () => {
    expect(isUnsupportedBinaryContentType("application/octet-stream")).toBe(true);
    expect(isUnsupportedBinaryContentType("application/zip")).toBe(true);
  });

  it("ignores a charset parameter when checking a real text content type", () => {
    expect(isUnsupportedBinaryContentType("text/html; charset=utf-8")).toBe(false);
  });

  it("does not flag PDF (handled separately, by its own extraction path)", () => {
    expect(isUnsupportedBinaryContentType("application/pdf")).toBe(false);
  });

  it("returns false for null (no content-type header at all)", () => {
    expect(isUnsupportedBinaryContentType(null)).toBe(false);
  });
});
