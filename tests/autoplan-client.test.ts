import { describe, expect, it } from "vitest";
import { humanizeProgressLabel, resolveProgressStage } from "@/lib/autoplan-client";

describe("humanizeProgressLabel", () => {
  it(
    "real regression: a raw multi-stage trace label used to reach the UI verbatim during a real " +
      'A/B/C run — "[max_experience] departure-safety-reroute:optimize: 3 çakışma tespit edildi" — ' +
      "translated to a clean, human sentence instead",
    () => {
      expect(humanizeProgressLabel("[max_experience] departure-safety-reroute:optimize: 3 çakışma tespit edildi")).toBe(
        "A seçeneği: Kalkış güvenliği kontrol ediliyor"
      );
    }
  );

  it('real case: a plain single-day discovery label — "discovery: 2999 aday (1500 m yarıçapta, OpenStreetMap)"', () => {
    expect(humanizeProgressLabel("discovery: 2999 aday (1500 m yarıçapta, OpenStreetMap)")).toBe("Yerler keşfediliyor");
  });

  it('real case: a multi-day label with a "Gün X/Y: " prefix', () => {
    expect(humanizeProgressLabel("Gün 1/3: discovery: 2999 aday (1500 m yarıçapta, OpenStreetMap)")).toBe(
      "Gün 1/3 — Yerler keşfediliyor"
    );
  });

  it("maps every real option-pace key this pipeline actually emits", () => {
    expect(humanizeProgressLabel("[balanced] routing:optimize: 2 çakışma tespit edildi")).toBe("B seçeneği: Rota hesaplanıyor");
    expect(humanizeProgressLabel("[relaxed] weather: rain")).toBe("C seçeneği: Hava durumu kontrol ediliyor");
  });

  it('real case: an "-reroute" suffixed stage still matches its base stage (hidden-gem-reroute)', () => {
    expect(humanizeProgressLabel("hidden-gem-reroute: OSRM matrisi hesaplandı")).toBe("Gizli hazineler aranıyor");
  });

  it('real case: "event-discovery" still matches the "event" stage', () => {
    expect(humanizeProgressLabel("event-discovery: 2 etkinlik listelendi")).toBe("Etkinlikler kontrol ediliyor");
  });

  it("falls back to a generic, still-honest message for a label this pipeline doesn't currently emit — never leaks the raw string", () => {
    expect(humanizeProgressLabel("some-future-stage: unexpected detail")).toBe("Plan hazırlanıyor");
  });

  it("an unrecognized bracketed option key is dropped rather than leaked", () => {
    expect(humanizeProgressLabel("[future_pace] discovery: 10 aday")).toBe("Yerler keşfediliyor");
  });
});

describe("resolveProgressStage", () => {
  it("resolves the same stage humanizeProgressLabel's sentence is built from", () => {
    expect(resolveProgressStage("event-discovery: 2 etkinlik listelendi")?.key).toBe("event");
    expect(resolveProgressStage("[balanced] routing:optimize: 2 çakışma tespit edildi")?.key).toBe("routing");
  });

  it("returns null for a label matching no known stage — a checklist must not tick a box for it", () => {
    expect(resolveProgressStage("some-future-stage: unexpected detail")).toBeNull();
  });
});
