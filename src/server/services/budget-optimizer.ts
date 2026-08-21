import "server-only";
import type { ScoredCandidate } from "@/server/services/discovery-scoring";
import type { StopInput } from "@/server/services/itinerary-optimizer";

/**
 * Real budget-driven replanning, not a passive warning.
 *
 * The previous behaviour only ever compared the finished itinerary's total
 * cost against the stated budget and, if it was over, appended a sentence to
 * that effect — the plan itself never changed. This module actually tries to
 * bring a plan back under budget: prefer swapping an expensive paid stop for
 * a free same-category alternative already in the discovered shortlist
 * (nothing invented — a real candidate, a real OSM `fee=no` tag or a
 * typically-free category, within real walking distance of the stop it
 * replaces); when no substitute exists, drop the single most expensive,
 * least-notable removable stop and try again.
 *
 * "Removable" excludes anything explicitly protected: a caller-supplied
 * must-see id, a locked stop, or a fixed-time stop (a booked show, a timed
 * entry slot) — those are never touched, silently or otherwise. The trip's
 * start/end points aren't part of the candidate list this operates on at
 * all, so departure/return points are inherently untouched too.
 *
 * Pure and network-free by design (no fetching here) so it's directly
 * unit-testable; the caller is responsible for re-running the deterministic
 * optimizer against a freshly-fetched matrix for whatever stop set this
 * returns.
 */

export interface RemovedStop {
  id: string;
  name: string;
  cost: number;
  reason: string;
}

export interface ReplacedStop {
  removedId: string;
  removedName: string;
  removedCost: number;
  addedId: string;
  addedName: string;
  reason: string;
}

export interface BudgetOptimizationResult {
  /** False when the budget was already satisfied, or no stop cost is known at all — nothing to do. */
  applied: boolean;
  /** True when the returned stop set's known cost is at or under budget. */
  satisfied: boolean;
  originalCost: number;
  optimizedCost: number;
  savedAmount: number;
  /** Stops whose cost was never discovered — excluded from both totals, so they're not silently assumed free. */
  unknownCostStopCount: number;
  removedStops: RemovedStop[];
  replacedStops: ReplacedStop[];
  /** Set only when `satisfied` is false: the lowest known cost reachable without touching a protected stop. */
  minimumFeasibleCost: number | null;
  reason: string;
}

interface WorkingStop {
  input: StopInput;
  scored: ScoredCandidate;
}

/** Categories that are typically free to enter even without an explicit OSM `fee` tag. */
const TYPICALLY_FREE_CATEGORIES = new Set([
  "park", "nature", "viewpoint", "church", "monument", "landmark", "market", "beach",
]);

function isFreeCandidate(c: ScoredCandidate): boolean {
  if (c.place.tags.fee === "no") return true;
  return TYPICALLY_FREE_CATEGORIES.has(c.category);
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

const SUBSTITUTE_MAX_DISTANCE_METERS = 2000;

function isProtected(stop: WorkingStop, mustSeeIds: ReadonlySet<string>): boolean {
  return mustSeeIds.has(stop.input.id) || !!stop.input.locked || !!stop.input.fixedTime;
}

export function planBudgetOptimization(
  finalStops: WorkingStop[],
  shortlist: ScoredCandidate[],
  budget: number,
  mustSeeIds: ReadonlySet<string> = new Set()
): { keptStops: WorkingStop[]; result: BudgetOptimizationResult } {
  const knownCostStops = finalStops.filter((s) => s.input.estimatedCost != null);
  const unknownCostStopCount = finalStops.length - knownCostStops.length;
  const originalCost = knownCostStops.reduce((sum, s) => sum + s.input.estimatedCost!, 0);

  if (originalCost <= budget) {
    return {
      keptStops: finalStops,
      result: {
        applied: false,
        satisfied: true,
        originalCost,
        optimizedCost: originalCost,
        savedAmount: 0,
        unknownCostStopCount,
        removedStops: [],
        replacedStops: [],
        minimumFeasibleCost: null,
        reason:
          knownCostStops.length === 0
            ? "hiçbir durağın maliyeti bilinmiyor — bütçe karşılanıyor gibi görünüyor ama bu doğrulanmış bir sonuç değil, bilgi eksikliği"
            : "bütçe zaten karşılanıyor, değişiklik gerekmedi",
      },
    };
  }

  const usedIds = new Set(finalStops.map((s) => s.input.id));
  let working = [...finalStops];
  const removedStops: RemovedStop[] = [];
  const replacedStops: ReplacedStop[] = [];

  const runningCost = () =>
    working.reduce((sum, s) => sum + (s.input.estimatedCost ?? 0), 0);

  const nextRemovalTarget = (): WorkingStop | null => {
    const candidates = working
      .filter((s) => (s.input.estimatedCost ?? 0) > 0 && !isProtected(s, mustSeeIds))
      .sort(
        (a, b) =>
          b.input.estimatedCost! - a.input.estimatedCost! || // most expensive first
          a.scored.notabilityScore - b.scored.notabilityScore // then least notable
      );
    return candidates[0] ?? null;
  };

  while (runningCost() > budget) {
    const target = nextRemovalTarget();
    if (!target) break; // nothing left we're allowed to touch

    const substitute = shortlist.find(
      (c) =>
        !usedIds.has(c.place.id) &&
        c.category === target.scored.category &&
        isFreeCandidate(c) &&
        haversineMeters(c.place, target.input) <= SUBSTITUTE_MAX_DISTANCE_METERS
    );

    working = working.filter((s) => s.input.id !== target.input.id);

    if (substitute) {
      usedIds.add(substitute.place.id);
      const distance = Math.round(haversineMeters(substitute.place, target.input));
      working.push({
        input: {
          id: substitute.place.id,
          name: substitute.place.name,
          lat: substitute.place.lat,
          lng: substitute.place.lng,
          category: substitute.category,
          estimatedCost: 0,
        },
        scored: substitute,
      });
      replacedStops.push({
        removedId: target.input.id,
        removedName: target.input.name,
        removedCost: target.input.estimatedCost!,
        addedId: substitute.place.id,
        addedName: substitute.place.name,
        reason: `ücretsiz aynı kategori (${substitute.category}) alternatif, ${distance} m mesafede`,
      });
    } else {
      removedStops.push({
        id: target.input.id,
        name: target.input.name,
        cost: target.input.estimatedCost!,
        reason: "bütçeyi aşan en pahalı/en az dikkat çekici ücretli durak; yakında ücretsiz alternatif bulunamadı",
      });
    }
  }

  const optimizedCost = runningCost();
  const satisfied = optimizedCost <= budget;

  return {
    keptStops: working,
    result: {
      applied: true,
      satisfied,
      originalCost,
      optimizedCost,
      savedAmount: originalCost - optimizedCost,
      unknownCostStopCount,
      removedStops,
      replacedStops,
      minimumFeasibleCost: satisfied ? null : optimizedCost,
      reason: satisfied
        ? `bütçeyi karşılamak için ${removedStops.length} durak çıkarıldı, ${replacedStops.length} durak ücretsiz alternatifle değiştirildi`
        : "zorunlu/sabit/kilitli duraklar korunduğu için bütçe tam karşılanamadı — ulaşılabilir minimum maliyet raporlandı",
    },
  };
}
