import { describe, expect, it } from "vitest";
import { extractJsonLdMenuItems } from "@/server/services/restaurant-extraction";

/**
 * Real schema.org Menu structured-data extraction (production-hardening
 * spec §3, "inspect JSON-LD") — a zero-LLM-risk source many restaurant site
 * builders emit even for otherwise JS-rendered pages, since search engines
 * consume it directly. Pure parsing logic, no network — matches this
 * project's convention (see official-site-crawler.test.ts) of unit-testing
 * extraction/scoring logic directly rather than mocking fetch.
 */
describe("extractJsonLdMenuItems", () => {
  it("extracts items from a real-shaped Restaurant -> Menu -> MenuSection -> MenuItem graph", () => {
    const html = `<html><head><script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Restaurant",
        "name": "Test Trattoria",
        "hasMenu": {
          "@type": "Menu",
          "hasMenuSection": [
            {
              "@type": "MenuSection",
              "name": "Pasta",
              "hasMenuItem": [
                { "@type": "MenuItem", "name": "Spaghetti Carbonara", "description": "Classic Roman pasta", "offers": { "@type": "Offer", "price": "12.50", "priceCurrency": "EUR" } }
              ]
            }
          ]
        }
      }
    </script></head><body></body></html>`;

    const items = extractJsonLdMenuItems(html);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("Spaghetti Carbonara");
    expect(items[0].category).toBe("Pasta");
    expect(items[0].price).toBe(12.5);
    expect(items[0].currency).toBe("EUR");
  });

  it("extracts items from a bare top-level Menu (no wrapping Restaurant node)", () => {
    const html = `<script type="application/ld+json">
      { "@type": "Menu", "name": "Drinks", "hasMenuItem": [{ "@type": "MenuItem", "name": "Espresso", "offers": { "price": 3 } }] }
    </script>`;
    const items = extractJsonLdMenuItems(html);
    expect(items.map((i) => i.name)).toEqual(["Espresso"]);
    expect(items[0].price).toBe(3);
  });

  it("handles an @graph array wrapper", () => {
    const html = `<script type="application/ld+json">
      { "@context": "https://schema.org", "@graph": [
        { "@type": "MenuItem", "name": "House Salad", "offers": { "price": 8, "priceCurrency": "USD" } }
      ]}
    </script>`;
    expect(extractJsonLdMenuItems(html).map((i) => i.name)).toEqual(["House Salad"]);
  });

  it("returns an empty array for malformed JSON rather than throwing", () => {
    const html = `<script type="application/ld+json">{ not valid json </script>`;
    expect(extractJsonLdMenuItems(html)).toEqual([]);
  });

  it("returns an empty array when no JSON-LD script tag is present at all", () => {
    expect(extractJsonLdMenuItems("<html><body><p>No structured data here</p></body></html>")).toEqual([]);
  });

  it("returns an empty array for JSON-LD that has nothing to do with a menu (e.g. Organization schema)", () => {
    const html = `<script type="application/ld+json">{ "@type": "Organization", "name": "Some Company" }</script>`;
    expect(extractJsonLdMenuItems(html)).toEqual([]);
  });

  it("ignores a MenuItem with no real name rather than inventing a placeholder", () => {
    const html = `<script type="application/ld+json">
      { "@type": "Menu", "hasMenuItem": [{ "@type": "MenuItem", "offers": { "price": 5 } }] }
    </script>`;
    expect(extractJsonLdMenuItems(html)).toEqual([]);
  });
});
