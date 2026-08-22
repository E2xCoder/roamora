import { describe, expect, it, beforeEach } from "vitest";
import {
  recordEngineSuccess,
  recordEngineFailure,
  recordSearchOutcome,
  getEngineHealthSnapshot,
  isEngineDown,
  areAllKnownEnginesDown,
  resetEngineHealth,
} from "@/server/providers/research/engine-health";

describe("engine-health", () => {
  beforeEach(() => resetEngineHealth());

  it("starts with no known engines, so 'all down' cannot be claimed with no evidence", () => {
    expect(areAllKnownEnginesDown()).toBe(false);
    expect(getEngineHealthSnapshot()).toEqual([]);
  });

  it("records a real failure and reports the engine as down", () => {
    recordEngineFailure("duckduckgo", "CAPTCHA");
    expect(isEngineDown("duckduckgo")).toBe(true);
    const snapshot = getEngineHealthSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ engine: "duckduckgo", failureCount: 1, lastFailureReason: "CAPTCHA" });
  });

  it("a success after a failure marks the engine as no longer down", () => {
    recordEngineFailure("bing", "timeout");
    expect(isEngineDown("bing")).toBe(true);
    recordEngineSuccess("bing");
    expect(isEngineDown("bing")).toBe(false);
  });

  it("real SearXNG response shape: ingests unresponsive_engines and responding engines together", () => {
    // Real shape observed live: {"unresponsive_engines": [["duckduckgo","CAPTCHA"],["startpage","CAPTCHA"]]}
    recordSearchOutcome(["bing", "qwant"], [
      ["duckduckgo", "CAPTCHA"],
      ["startpage", "CAPTCHA"],
    ]);
    expect(isEngineDown("bing")).toBe(false);
    expect(isEngineDown("qwant")).toBe(false);
    expect(isEngineDown("duckduckgo")).toBe(true);
    expect(isEngineDown("startpage")).toBe(true);
  });

  it("'all known engines down' is only true when every engine ever observed is currently down", () => {
    recordEngineFailure("duckduckgo", "CAPTCHA");
    recordEngineFailure("qwant", "CAPTCHA");
    expect(areAllKnownEnginesDown()).toBe(true);
    recordEngineSuccess("qwant");
    expect(areAllKnownEnginesDown()).toBe(false);
  });

  it("an engine never observed at all is not reported as down (no false positive from absence)", () => {
    recordEngineFailure("duckduckgo", "CAPTCHA");
    expect(isEngineDown("mojeek")).toBe(false);
  });
});
