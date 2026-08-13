const WIKI_API = "https://en.wikivoyage.org/w/api.php";

export async function searchDestination(query: string) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srnamespace: "0",
    srlimit: "10",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  if (!res.ok) throw new Error(`Wikivoyage API error: ${res.status}`);
  const data = await res.json();
  return data.query.search as Array<{ title: string; snippet: string; pageid: number }>;
}

export async function getDestinationContent(title: string) {
  const params = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "sections|wikitext",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  if (!res.ok) throw new Error(`Wikivoyage API error: ${res.status}`);
  const data = await res.json();
  return {
    title: data.parse.title,
    sections: data.parse.sections as Array<{
      toclevel: number;
      line: string;
      number: string;
      index: string;
    }>,
    wikitext: data.parse.wikitext?.["*"] || "",
  };
}

export async function getDestinationSection(title: string, sectionIndex: string) {
  const params = new URLSearchParams({
    action: "parse",
    page: title,
    section: sectionIndex,
    prop: "wikitext",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`${WIKI_API}?${params}`);
  if (!res.ok) throw new Error(`Wikivoyage API error: ${res.status}`);
  const data = await res.json();
  return data.parse.wikitext?.["*"] || "";
}

export function parseListings(wikitext: string) {
  const listingRegex = /\{\{(?:listing|see|do|eat|drink|sleep|buy)\s*\|([^}]+)\}\}/gi;
  const listings: Array<{
    name: string;
    lat?: number;
    lng?: number;
    address?: string;
    description?: string;
    type: string;
  }> = [];

  let match;
  while ((match = listingRegex.exec(wikitext)) !== null) {
    const params = match[1];
    const getParam = (key: string) => {
      const m = params.match(new RegExp(`${key}\\s*=\\s*([^|]+)`));
      return m ? m[1].trim() : undefined;
    };
    const name = getParam("name");
    if (!name) continue;

    listings.push({
      name,
      lat: getParam("lat") ? parseFloat(getParam("lat")!) : undefined,
      lng: getParam("long") ? parseFloat(getParam("long")!) : undefined,
      address: getParam("address"),
      description: getParam("content") || getParam("description"),
      type: match[0].match(/\{\{(\w+)/)?.[1] || "listing",
    });
  }
  return listings;
}
