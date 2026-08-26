import { describe, expect, it } from "vitest";
import { looseTextToOsmSyntax, htmlToPlainText, repairTruncatedJsonArray } from "@/server/services/fact-extraction";

describe("htmlToPlainText", () => {
  it("strips tags, scripts, styles and comments down to visible text", () => {
    const html = `<!DOCTYPE html><html><head><script>track();</script><style>.a{color:red}</style></head><body><!-- note --><h1>Ratusz</h1><p>Godziny otwarcia: 9:00-17:00</p></body></html>`;
    expect(htmlToPlainText(html)).toBe("Ratusz Godziny otwarcia: 9:00-17:00");
  });

  it("decodes common HTML entities, including numeric ones", () => {
    expect(htmlToPlainText("<p>Ratusz &amp; Rynek&nbsp;&#8211;&nbsp;Pozna&#324;</p>")).toBe(
      "Ratusz & Rynek – Poznań"
    );
  });

  it(
    "regression: a real page's meaningful content can sit far past a raw-HTML " +
      "4000-character window — the extractor used to slice raw HTML directly " +
      '(bug found via a real Poznań museum page: its "GODZINY OTWARCIA" ' +
      "heading sat at raw byte 51,422), so stripping to plain text first must " +
      "bring real content within a 4000-char slice of a page with a large " +
      "<head>.",
    () => {
      const bigHead = "<head>" + "<meta name=\"x\" content=\"y\"/>".repeat(2000) + "</head>";
      const html = `<html>${bigHead}<body><h1>Real Museum</h1><p>Opening hours: Mo-Fr 09:00-17:00</p></body></html>`;
      expect(html.indexOf("Opening hours")).toBeGreaterThan(4000); // reproduces the real bug's shape
      const plain = htmlToPlainText(html);
      expect(plain.slice(0, 4000)).toContain("Opening hours: Mo-Fr 09:00-17:00");
    }
  );
});

describe("looseTextToOsmSyntax", () => {
  it("converts a valid English day-name statement to OSM syntax", () => {
    expect(looseTextToOsmSyntax("Mon-Fri 9:00-17:00")).toBe("Mo-Fr 09:00-17:00");
  });

  it("pads single-digit hours", () => {
    expect(looseTextToOsmSyntax("Sat 9:00-14:00")).toBe("Sa 09:00-14:00");
  });

  it(
    "rejects a live-hours-widget date stamp misidentified as opening hours " +
      '(regression: a real llama3.1:8b extraction over a real Poznań museum ' +
      'page returned "Dzisiaj Poniedziałek 24.10.2022" as openingHoursText — ' +
      "the page's stale \"today is Monday 24.10.2022\" label, not actual " +
      "hours. This must fail conversion rather than silently becoming a " +
      "confident-looking OSM constraint fed into the optimizer.)",
    () => {
      expect(looseTextToOsmSyntax("Dzisiaj Poniedziałek 24.10.2022")).toBeNull();
    }
  );

  it("rejects free text with no recognisable day/time pattern", () => {
    expect(looseTextToOsmSyntax("open most days, call ahead")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(looseTextToOsmSyntax("")).toBeNull();
    expect(looseTextToOsmSyntax("   ")).toBeNull();
  });
});

describe("looseTextToOsmSyntax — multilingual, real extraction test cases", () => {
  it(
    "German, no day mentioned — a real llama3.1:8b extraction over the " +
      'Rijksmuseum\'s official page returned openingHoursText "9 bis 17 Uhr" ' +
      '(the source said "Sie sind täglich von 9 bis 17 Uhr willkommen" — the ' +
      '"täglich"/daily qualifier was stripped along with the day mention, ' +
      "which is why this must default to every day rather than being rejected " +
      "for having no day name)",
    () => {
      expect(looseTextToOsmSyntax("9 bis 17 Uhr")).toBe("Mo-Su 09:00-17:00");
    }
  );

  it(
    "French, no day mentioned, midnight close — a real extraction over the " +
      'Eiffel Tower\'s official French page ("Ouvert aujourd\'hui 09:00 - ' +
      '00:00") returned openingHoursText "09:00 - 00:00"; a literal "00:00" ' +
      "close cannot be expressed as a same-day close, so it must become the " +
      'existing "23:59" end-of-day sentinel, not a zero-width or wrapped span',
    () => {
      expect(looseTextToOsmSyntax("09:00 - 00:00")).toBe("Mo-Su 09:00-23:59");
    }
  );

  it(
    "Polish, two day-ranges with distinct hours — a real extraction over " +
      "Brama Poznania ICHOT's real page returned this exact string; Polish " +
      'day abbreviations ("Wt.", "Pt.", "So.", "Nd.") are not in an ' +
      "English-only table, and this exercises grouping two separate " +
      "day-range+time-range pairs in one string",
    () => {
      expect(looseTextToOsmSyntax("Wt. - Pt.: 9:00 - 18:00 So. - Nd.: 10:00 - 19:00")).toBe(
        "Tu-Fr 09:00-18:00; Sa-Su 10:00-19:00"
      );
    }
  );

  it(
    "Turkish, real hallucination — a real extraction over a Hagia Sophia " +
      '"best time to visit" page returned this exact string as ' +
      "openingHoursText: a crowd-calendar widget's day-abbreviation-plus-" +
      "legend text (seven real Turkish day names — Pzt/Sal/Çar/Per/Cum/Cmt/" +
      'Paz — followed by "Hoş/Kalabalık/Çok Kalabalık/Kapalı", meaning ' +
      '"Nice/Crowded/Very Crowded/Closed") instead of the real "8:00–19:30" ' +
      "a few lines earlier on the same page. Zero digits anywhere in this " +
      "string means it must be rejected outright, regardless of how many " +
      "real day names it contains.",
    () => {
      expect(
        looseTextToOsmSyntax("Pzt Sal Çar Per Cum Cmt Paz Hoş Kalabalık Çok Kalabalık Kapalı")
      ).toBeNull();
    }
  );

  it(
    'resolves the German/Polish "So" ambiguity (Sonntag/Sunday vs Sobota/' +
      "Saturday) by picking whichever language's table matches the most " +
      "day-tokens in the string, not by a fixed per-language check order",
    () => {
      // "Mo" and "Fr" only exist in the German/English tables, not Polish —
      // German should win here with 3 matches against Polish's 1 ("So").
      expect(looseTextToOsmSyntax("Mo-Fr 09:00-17:00, So 10:00-14:00")).toBe(
        "Mo-Fr 09:00-17:00; Su 10:00-14:00"
      );
    }
  );

  it("rejects the whole result when one day-group has no time range immediately after it, even if another group does", () => {
    // "Mo-Fr" has nothing but words before "So" starts — that group can't be
    // paired, so the entire string is refused, not just that one group.
    expect(looseTextToOsmSyntax("Mo-Fr open all year So 10:00-14:00")).toBeNull();
  });

  it("does not collapse a comma-separated day list into a wrong range", () => {
    // "Mo, We, Fr" must not become "Mo-Fr" (which would wrongly include
    // Tuesday and Thursday) — comma is deliberately not a mergeable connector,
    // so this correctly refuses rather than guessing.
    expect(looseTextToOsmSyntax("Mo, We, Fr 09:00-17:00")).toBeNull();
  });

  it("does not mistake a price or page-count range for a time range", () => {
    expect(looseTextToOsmSyntax("Tickets from 15-25 for adults")).toBeNull();
  });

  it(
    'English "to" separator — real extractions over the Anne Frank House and Rijksmuseum ' +
      'official pages returned "daily 9:00 to 22:00" and "Open daily 9 to 17h" respectively; ' +
      'the parser only recognised "-"/"bis" as range separators, never the word "to", so both ' +
      "correct, textually-supported extractions were silently rejected as unparseable",
    () => {
      expect(looseTextToOsmSyntax("daily 9:00 to 22:00")).toBe("Mo-Su 09:00-22:00");
      expect(looseTextToOsmSyntax("Open daily 9 to 17h")).toBe("Mo-Su 09:00-17:00");
    }
  );

  it(
    "accepts a range where only one side carries an explicit time marker, as long as at " +
      'least one side does (the other real half of the "9 to 17h" shape)',
    () => {
      expect(looseTextToOsmSyntax("9 to 17:00")).toBe("Mo-Su 09:00-17:00");
    }
  );

  it('still rejects a bare "N to M" with no time marker on either side, same as the dash-separated price-range case', () => {
    expect(looseTextToOsmSyntax("9 to 17")).toBeNull();
    expect(looseTextToOsmSyntax("rooms available from 5 to 12")).toBeNull();
  });

  it(
    'English AM/PM — a real re-extraction of the Rijksmuseum page returned ' +
      '"Daily, 365 days a year from 9 a.m. to 5 p.m." (hoursScope: "daily") ' +
      "on a later live run; the parser previously had no AM/PM support at " +
      "all and could not convert this common format",
    () => {
      expect(looseTextToOsmSyntax("Daily, 365 days a year from 9 a.m. to 5 p.m.")).toBe(
        "Mo-Su 09:00-17:00"
      );
    }
  );

  it("does not false-positive AM/PM matching on an unrelated 'a year'/day-count phrase", () => {
    expect(looseTextToOsmSyntax("Open 365 days a year, hours vary by season")).toBeNull();
  });

  it("handles AM/PM without periods and with minutes", () => {
    expect(looseTextToOsmSyntax("9:30am-5:00pm")).toBe("Mo-Su 09:30-17:00");
  });

  it("handles 12pm/12am correctly (noon and midnight, not '12:00' literally added to 12)", () => {
    expect(looseTextToOsmSyntax("12am-12pm")).toBe("Mo-Su 00:00-12:00");
  });

  it(
    "real, serious regression: a real Czech museum's real Monday-through-Sunday hours table " +
      '("Pondělí 10:00 - 18:00, Úterý 10:00 - 18:00, ..., Neděle 10:00 - 18:00") used to silently ' +
      "produce a WRONG result — Czech had no day-name coverage at all, so \"Sobota\" (Saturday) " +
      'coincidentally matched the POLISH map\'s "sobota" (also Saturday, an unrelated language) ' +
      "as the single best match, collapsing a real 7-day schedule into Saturday-only " +
      '("Sa 10:00-18:00"). Silently wrong is worse than the string simply being unrecognised.',
    () => {
      const real =
        "Pondělí 10:00 - 18:00, Úterý 10:00 - 18:00, Středa 10:00 - 18:00, Čtvrtek 10:00 - 18:00, " +
        "Pátek 10:00 - 18:00, Sobota 10:00 - 18:00, Neděle 10:00 - 18:00";
      expect(looseTextToOsmSyntax(real)).toBe(
        "Mo 10:00-18:00; Tu 10:00-18:00; We 10:00-18:00; Th 10:00-18:00; Fr 10:00-18:00; Sa 10:00-18:00; Su 10:00-18:00"
      );
    }
  );

  it("recognizes standard Czech day abbreviations (Po/Út/St/Čt/Pá/So/Ne)", () => {
    expect(looseTextToOsmSyntax("Po-Pá 08:00-16:00")).toBe("Mo-Fr 08:00-16:00");
  });

  it(
    'real case: a real Prague gallery\'s real hours ("út–ne: 10.00–18.00" — Tue-Sun, period- ' +
      "separated times, not colons) resolves correctly once both the Czech day abbreviation and " +
      "the period time format are recognized",
    () => {
      expect(looseTextToOsmSyntax("út–ne: 10.00–18.00")).toBe("Tu-Su 10:00-18:00");
    }
  );

  it("recognizes a period-separated time range in isolation (European decimal-style hours)", () => {
    expect(looseTextToOsmSyntax("Mo-Fr 09.00-17.00")).toBe("Mo-Fr 09:00-17:00");
  });

  it(
    "accepted tradeoff, documented rather than silent: a period is also a real, common minute " +
      'marker ("10.00" = 10:00), so a decimal-looking number range with a day-shaped hour/minute ' +
      "split (\"10.00-15.00\") reads as a time even with no day name around it — same as the " +
      "existing bare-colon/'h'/AM-PM behavior for a day-less string elsewhere in this file. This " +
      "function is only ever run on the model's own openingHoursText field, already classified as " +
      "being about hours before this parser ever sees it — not on arbitrary page text where a real " +
      "decimal price could plausibly collide with this shape.",
    () => {
      expect(looseTextToOsmSyntax("Discount 10.00-15.00 for members")).toBe("Mo-Su 10:00-15:00");
    }
  );

  it(
    "real regression: Muzeum Karla Zemana's real Czech prose hours — a day range and a time " +
      'range both using the word "do" ("to") as their connector instead of a dash — resolves ' +
      'correctly ("pondělí do neděle od 10:00 do 19:00")',
    () => {
      expect(looseTextToOsmSyntax("pondělí do neděle od 10:00 do 19:00")).toBe("Mo-Su 10:00-19:00");
    }
  );

  it(
    'real-shaped case: a day range ending in a day whose Czech genitive form differs from its ' +
      'nominative ("pátek" -> "pátku" after "do") — "pondělí do pátku od 09:00 do 17:00"',
    () => {
      expect(looseTextToOsmSyntax("pondělí do pátku od 09:00 do 17:00")).toBe("Mo-Fr 09:00-17:00");
    }
  );

  it("handles mixed Czech day abbreviations with the word connector (not just full names)", () => {
    expect(looseTextToOsmSyntax("Po do Pá od 09:00 do 17:00")).toBe("Mo-Fr 09:00-17:00");
    expect(looseTextToOsmSyntax("út do pá 10:00 do 20:00")).toBe("Tu-Fr 10:00-20:00");
  });

  it(
    "known, accepted limitation: a Czech abbreviation pair that BOTH happen to double-collide " +
      'with German abbreviations ("so" is also Sonntag/Sunday in German, on top of "do" already ' +
      "being Donnerstag/Thursday) can tie on distinct-day-code count too — this stays honestly " +
      "unknown rather than guessing between two equally-plausible readings; no real Prague page " +
      "has been observed producing this specific double collision",
    () => {
      expect(looseTextToOsmSyntax("út do so 10:00 do 20:00")).toBeNull();
    }
  );

  it("still supports the existing dash-based Czech range alongside the new word-connector form", () => {
    expect(looseTextToOsmSyntax("Pondělí-Pátek 09:00-17:00")).toBe("Mo-Fr 09:00-17:00");
  });

  it(
    "does not merge across 'do' when it is not standing alone between two day names — real " +
      "guard against unrelated prose, not just a happy-path check",
    () => {
      // "do otevření" ("until opening") is unrelated filler between the two day mentions, not a
      // clean day-range connector — the exact-match requirement in isPureConnector must reject it.
      expect(looseTextToOsmSyntax("pondělí do otevření neděle 10:00-19:00")).toBeNull();
    }
  );

  it("leaves a genuinely ambiguous, non-hours Czech sentence unknown rather than guessing", () => {
    expect(looseTextToOsmSyntax("Muzeum je otevřeno téměř denně, volejte prosím předem")).toBeNull();
  });

  it("does not regress existing English/German/Polish word-connector-free behavior", () => {
    expect(looseTextToOsmSyntax("Mon-Fri 9:00-17:00")).toBe("Mo-Fr 09:00-17:00");
    expect(looseTextToOsmSyntax("9 bis 17 Uhr")).toBe("Mo-Su 09:00-17:00");
    expect(looseTextToOsmSyntax("Wt. - Pt.: 9:00 - 18:00 So. - Nd.: 10:00 - 19:00")).toBe(
      "Tu-Fr 09:00-18:00; Sa-Su 10:00-19:00"
    );
  });
});

describe("repairTruncatedJsonArray", () => {
  it(
    "real case: salvages complete items from a response cut off mid-array (a real llama3.1:8b " +
      "response over a real German restaurant menu page truncated one item short of the closing " +
      "bracket at a 1500-token budget — this must recover the 14 real, complete items rather than " +
      "losing all of them to a single JSON.parse failure)",
    () => {
      const raw = `{"menuItems":[{"category":"SUPPEN","name":"Erdäpfelsuppe","price":4.5,"currency":"Euro"},{"category":"HAUPTGERICHTE","name":"Wiener Schnitzel","price":18.2,"currency":"Euro"},{"category":"SÜSSE","name":"Apfelstru`;
      const items = repairTruncatedJsonArray(raw, "menuItems") as Array<{ name: string }>;
      expect(items).toHaveLength(2);
      expect(items[0].name).toBe("Erdäpfelsuppe");
      expect(items[1].name).toBe("Wiener Schnitzel");
    }
  );

  it("returns every item unchanged when the array was never truncated at all", () => {
    const raw = `{"menuItems":[{"name":"A"},{"name":"B"},{"name":"C"}]}`;
    expect(repairTruncatedJsonArray(raw, "menuItems")).toEqual([{ name: "A" }, { name: "B" }, { name: "C" }]);
  });

  it("returns an empty array when the named key is not present at all", () => {
    expect(repairTruncatedJsonArray(`{"other":[{"name":"A"}]}`, "menuItems")).toEqual([]);
  });

  it("returns an empty array when truncation happens before any item completes", () => {
    expect(repairTruncatedJsonArray(`{"menuItems":[{"name":"Incomple`, "menuItems")).toEqual([]);
  });

  it("does not get confused by a comma or brace inside a string value", () => {
    const raw = `{"menuItems":[{"name":"Salt, Pepper {and} Spice","price":5},{"name":"Trunca`;
    const items = repairTruncatedJsonArray(raw, "menuItems") as Array<{ name: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Salt, Pepper {and} Spice");
  });

  it("works on the second occurrence's key name (events, not menuItems)", () => {
    const raw = `{"events":[{"eventName":"Festival A","startDate":"2026-06-01"},{"eventName":"Trunc`;
    const items = repairTruncatedJsonArray(raw, "events") as Array<{ eventName: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].eventName).toBe("Festival A");
  });
});
