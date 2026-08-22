import { describe, expect, it } from "vitest";
import { isMenuItemNameSupported, estimateQueueSignal, scoreTouristTrapRisk } from "@/server/services/restaurant-guard";

describe("isMenuItemNameSupported", () => {
  it("accepts a menu item name actually present in the source", () => {
    expect(isMenuItemNameSupported("Pierogi Ruskie", "Nasze menu: Pierogi Ruskie 25 zł, Żurek 18 zł")).toBe(true);
  });

  it("rejects a menu item name with no textual support (hallucination-shaped)", () => {
    expect(isMenuItemNameSupported("Lobster Thermidor", "Nasze menu: Pierogi Ruskie 25 zł, Żurek 18 zł")).toBe(false);
  });
});

describe("estimateQueueSignal", () => {
  it("returns null when there is no real evidence at all", () => {
    expect(estimateQueueSignal("A nice restaurant with good food and friendly staff.")).toBeNull();
  });

  it("reports a low-confidence narrow range for a single distinct signal", () => {
    const result = estimateQueueSignal("Expect a long queue outside on weekends.");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.range).toContain("10-20");
  });

  it("reports a medium-confidence wider range for two distinct signal kinds", () => {
    const result = estimateQueueSignal("There is often a long queue, and it's always busy in the evenings.");
    expect(result!.confidence).toBe("medium");
  });

  it("flags reservationRecommended when a reservation phrase is present", () => {
    const result = estimateQueueSignal("Reservation recommended, especially on weekends.");
    expect(result!.reservationRecommended).toBe(true);
  });

  it("does not flag reservationRecommended when only a queue phrase is present", () => {
    const result = estimateQueueSignal("Long queue outside most days.");
    expect(result!.reservationRecommended).toBe(false);
  });

  it("recognizes multilingual phrases (German, Polish, Turkish)", () => {
    expect(estimateQueueSignal("Es gibt oft eine lange Schlange vor dem Restaurant.")).not.toBeNull();
    expect(estimateQueueSignal("Zawsze jest długa kolejka, trzeba czekać.")).not.toBeNull();
    expect(estimateQueueSignal("Genellikle uzun kuyruk oluyor.")).not.toBeNull();
  });

  it("never reports an exact minute figure, only a range", () => {
    const result = estimateQueueSignal("Long queue outside, always busy, book ahead, slow service reported.");
    expect(result!.range).toMatch(/-|\+/); // a band, not a single number
    expect(result!.confidence).not.toBe("high"); // never more than medium — this is soft evidence
  });
});

describe("scoreTouristTrapRisk", () => {
  it("reports LOW with no reasons when there is no evidence either way", () => {
    const result = scoreTouristTrapRisk("A nice restaurant with good food.", false);
    expect(result.risk).toBe("LOW");
    expect(result.reasons).toEqual([]);
  });

  it("reports LOW for an official source even with no explicit authenticity phrase", () => {
    const result = scoreTouristTrapRisk("A nice restaurant with good food.", true);
    expect(result.risk).toBe("LOW");
  });

  it("reports LOW when a real authenticity phrase is present", () => {
    const result = scoreTouristTrapRisk("This is a local favorite, where locals eat.", false);
    expect(result.risk).toBe("LOW");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("reports MEDIUM for a single negative signal", () => {
    const result = scoreTouristTrapRisk("Some reviews say it's a bit overpriced.", false);
    expect(result.risk).toBe("MEDIUM");
  });

  it("reports HIGH for multiple negative signals", () => {
    const result = scoreTouristTrapRisk("Many call this a tourist trap, and it's clearly overpriced.", false);
    expect(result.risk).toBe("HIGH");
  });

  it("reports HIGH for an explicit tourist-menu mention combined with another negative signal", () => {
    const result = scoreTouristTrapRisk("They offer a tourist menu, and it's quite overpriced compared to nearby places.", false);
    expect(result.risk).toBe("HIGH");
  });

  it("does NOT reject a famous restaurant automatically — fame alone is not a negative signal", () => {
    const result = scoreTouristTrapRisk("One of the most famous and iconic restaurants in the city, beloved by visitors.", true);
    expect(result.risk).toBe("LOW");
  });

  it("recognizes multilingual negative signals (German, French, Polish, Turkish)", () => {
    expect(scoreTouristTrapRisk("Klar eine Touristenfalle, viel zu teuer und überteuert.", false).risk).toBe("HIGH");
    expect(scoreTouristTrapRisk("C'est un piège à touristes, beaucoup trop cher.", false).risk).toBe("HIGH");
    expect(scoreTouristTrapRisk("To pułapka na turystów, mocno przepłacony.", false).risk).toBe("HIGH");
    expect(scoreTouristTrapRisk("Turist tuzağı, gerçekten aşırı pahalı.", false).risk).toBe("HIGH");
  });
});
