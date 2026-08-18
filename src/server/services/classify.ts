import { CATEGORY_BY_ID } from "@/lib/taxonomy";

/**
 * Keyword classification into the controlled taxonomy.
 *
 * Rules are ordered most-specific first, since "coffee shop" should land on
 * cafe rather than shopping. This is a deliberate first pass, not a claim of
 * accuracy — `classificationConfidence` records how it was reached, and the
 * user can always override (spec §90).
 */

interface Rule {
  category: string;
  /** Higher wins when several rules match. */
  weight: number;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { category: "cafe", weight: 9, pattern: /\b(cafe|café|kafe|kahve|coffee|espresso|latte|cappuccino|kahvalt)/iu },
  { category: "bakery", weight: 9, pattern: /\b(bakery|pastane|patisserie|boulangerie|börek|croissant|fırın)/iu },
  { category: "bar", weight: 9, pattern: /\b(cocktail|kokteyl|bar\b|pub\b|brewery|birahane|wine bar|meyhane)/iu },
  { category: "nightlife", weight: 8, pattern: /\b(nightlife|nightclub|gece kulüb|disco|clubbing|rave|dj set)/iu },
  { category: "restaurant", weight: 8, pattern: /\b(restaurant|restoran|lokanta|ristorante|bistro|trattoria|dinner|akşam yemeği|steakhouse|yemek|eat here|street food)/iu },
  { category: "market", weight: 8, pattern: /\b(market|pazar|bazaar|çarşı|mercado|marché|farmers market)/iu },

  { category: "viewpoint", weight: 9, pattern: /\b(viewpoint|manzara|panorama|lookout|sunset|sunrise|gün batımı|seyir teras|rooftop)/iu },
  { category: "beach", weight: 9, pattern: /\b(beach|plaj|sahil|strand|plage|spiaggia|cove|koy\b)/iu },
  { category: "hike", weight: 9, pattern: /\b(hike|hiking|trail|trek|wander|yürüyüş|patika|via ferrata|summit|zirve)/iu },
  { category: "cycling", weight: 8, pattern: /\b(cycling|bike route|bisiklet|radweg|velo)/iu },
  { category: "park", weight: 7, pattern: /\b(park\b|garden|bahçe|botanic|jardin)/iu },
  { category: "nature", weight: 6, pattern: /\b(waterfall|şelale|lake|göl\b|forest|orman|canyon|kanyon|cave|mağara|glacier|volcano|nature|doğa|island|ada\b)/iu },

  { category: "museum", weight: 9, pattern: /\b(museum|müze|gallery|galeri|exhibition|sergi)/iu },
  { category: "castle", weight: 9, pattern: /\b(castle|kale\b|schloss|château|fortress|hisar)/iu },
  { category: "church", weight: 9, pattern: /\b(church|kilise|cathedral|katedral|basilica|chapel|mosque|cami|synagogue|sinagog|temple|tapınak)/iu },
  { category: "monument", weight: 7, pattern: /\b(monument|anıt|memorial|statue|heykel|obelisk)/iu },
  { category: "historic", weight: 6, pattern: /\b(historic|tarihi|ancient|antik|ruins|harabe|archaeolog|arkeolo|old town|eski şehir|medieval)/iu },
  { category: "architecture", weight: 5, pattern: /\b(architecture|mimari|art nouveau|bauhaus|brutalis|gothic|baroque)/iu },

  { category: "neighborhood", weight: 6, pattern: /\b(neighbou?rhood|district|mahalle|quarter|barrio|viertel)/iu },
  { category: "shopping", weight: 5, pattern: /\b(shopping|alışveriş|mall|boutique|store|shop\b|vintage)/iu },
  { category: "accommodation", weight: 7, pattern: /\b(hotel|otel|hostel|guesthouse|pansiyon|airbnb|resort|camping|kamp)/iu },
  { category: "transport", weight: 6, pattern: /\b(airport|havaliman|train station|gar\b|metro|ferry|vapur|funicular)/iu },

  { category: "hidden-gem", weight: 4, pattern: /\b(hidden gem|hidden|gizli|secret|gizli kalmış|off the beaten|az bilinen|tourists don'?t)/iu },
  { category: "local-experience", weight: 4, pattern: /\b(local experience|like a local|yerel deneyim|workshop|atölye|cooking class)/iu },
  { category: "activity", weight: 3, pattern: /\b(kayak|rafting|paragliding|yamaç paraşüt|diving|dalış|ski|kayak yap|surf)/iu },
  { category: "landmark", weight: 3, pattern: /\b(landmark|tower|kule|bridge|köprü|palace|saray|square|meydan)/iu },
];

export function guessCategoryFromText(text: string, placeName = ""): string {
  // The place's own name is the strongest signal, so it is weighted heavier.
  const haystack = `${placeName} ${placeName} ${text}`;

  let best: { category: string; weight: number } | null = null;

  for (const rule of RULES) {
    if (!rule.pattern.test(haystack)) continue;
    if (!best || rule.weight > best.weight) {
      best = { category: rule.category, weight: rule.weight };
    }
  }

  const category = best?.category ?? "attraction";
  // Never emit an id the taxonomy does not know.
  return CATEGORY_BY_ID.has(category) ? category : "attraction";
}
