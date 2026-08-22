import { describe, expect, it } from "vitest";
import { findEatSectionIndex, wikitextToPlainText, cityNameForWikivoyageSearch } from "@/server/services/wikivoyage-research";

describe("cityNameForWikivoyageSearch", () => {
  it(
    "real case: reduces 'Prague, Czech Republic' to just 'Prague' — searching the full string " +
      "returned Wikivoyage's Czech Republic COUNTRY article ranked above Prague's own city " +
      "article, so a real Prague trip's local-food facts came back nationwide instead of " +
      "city-specific",
    () => {
      expect(cityNameForWikivoyageSearch("Prague, Czech Republic")).toBe("Prague");
    }
  );

  it("real case: reduces 'Amsterdam, Netherlands' to just 'Amsterdam' (same real bug)", () => {
    expect(cityNameForWikivoyageSearch("Amsterdam, Netherlands")).toBe("Amsterdam");
  });

  it("returns a bare city name unchanged when there is no country suffix", () => {
    expect(cityNameForWikivoyageSearch("Poznań")).toBe("Poznań");
  });

  it("trims surrounding whitespace", () => {
    expect(cityNameForWikivoyageSearch("  Berlin  , Germany")).toBe("Berlin");
  });

  it("falls back to the original string if splitting somehow leaves nothing usable", () => {
    expect(cityNameForWikivoyageSearch(", Germany")).toBe(", Germany");
  });
});

describe("findEatSectionIndex", () => {
  it("finds the standard 'Eat' section, case-insensitively", () => {
    const sections = [
      { line: "Understand", index: "1" },
      { line: "Get in", index: "2" },
      { line: "See", index: "3" },
      { line: "Eat", index: "4" },
      { line: "Drink", index: "5" },
    ];
    expect(findEatSectionIndex(sections)).toBe("4");
  });

  it("matches 'Eat and drink' as one combined section", () => {
    const sections = [
      { line: "See", index: "1" },
      { line: "Eat and drink", index: "2" },
    ];
    expect(findEatSectionIndex(sections)).toBe("2");
  });

  it("returns null when the article has no Eat section at all", () => {
    const sections = [
      { line: "Understand", index: "1" },
      { line: "See", index: "2" },
    ];
    expect(findEatSectionIndex(sections)).toBeNull();
  });

  it("does not false-match an unrelated section merely containing 'eat' as a substring", () => {
    const sections = [{ line: "Weather", index: "1" }];
    expect(findEatSectionIndex(sections)).toBeNull();
  });

  it("trims whitespace before matching", () => {
    const sections = [{ line: "  Eat  ", index: "3" }];
    expect(findEatSectionIndex(sections)).toBe("3");
  });
});

describe("wikitextToPlainText", () => {
  it("keeps a listing template's readable parameter values, dropping the markup", () => {
    const wikitext = "{{eat|name=Bar Alaska|content=Known for its pierogi and traditional Polish dishes}}";
    const text = wikitextToPlainText(wikitext);
    expect(text).toContain("Bar Alaska");
    expect(text).toContain("Known for its pierogi and traditional Polish dishes");
    expect(text).not.toContain("{{");
    expect(text).not.toContain("name=");
  });

  it("converts [[link|Display]] to just Display", () => {
    expect(wikitextToPlainText("Try the [[pierogi|Polish dumplings]] here.")).toBe("Try the Polish dumplings here.");
  });

  it("converts a bare [[Display]] link to just Display", () => {
    expect(wikitextToPlainText("Visit [[Poznań]] for great food.")).toBe("Visit Poznań for great food.");
  });

  it("strips bold and italic markup", () => {
    expect(wikitextToPlainText("'''Bold text''' and ''italic text''.")).toBe("Bold text and italic text.");
  });

  it("strips section headers down to their title text", () => {
    expect(wikitextToPlainText("==Eat==\nSome text.")).toBe("Eat Some text.");
  });

  it("strips <ref> citation blocks entirely", () => {
    expect(wikitextToPlainText("A local dish<ref>Some citation, 2020</ref> worth trying.")).toBe(
      "A local dish worth trying."
    );
  });

  it("handles a real multi-listing Eat section without throwing and preserves the real content", () => {
    const wikitext =
      "The city is known for its '''pierogi''' and ''świeżak''.\n" +
      "{{eat|name=Ministerstwo Śledzia i Wódki|content=Traditional Polish tavern known for herring dishes}}\n" +
      "{{eat|name=Bar Alaska|content=Cheap and cheerful, a local favorite for pierogi}}";
    const text = wikitextToPlainText(wikitext);
    expect(text).toContain("pierogi");
    expect(text).toContain("Ministerstwo Śledzia i Wódki");
    expect(text).toContain("Traditional Polish tavern known for herring dishes");
    expect(text).toContain("Bar Alaska");
  });
});
