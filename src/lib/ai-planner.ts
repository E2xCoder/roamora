import type { TripPlanDay } from "@/types";

interface PlanRequest {
  destination: string;
  days: number;
  startDate: string;
  preferences: string[];
  savedPlaces: Array<{ name: string; lat: number; lng: number; category: string }>;
}

export async function generateTripPlan(req: PlanRequest): Promise<TripPlanDay[]> {
  const savedPlacesText =
    req.savedPlaces.length > 0
      ? `The user has these saved places near ${req.destination}:\n${req.savedPlaces
          .map((p) => `- ${p.name} (${p.category}) at [${p.lat}, ${p.lng}]`)
          .join("\n")}\nPrioritize these in the plan.`
      : "";

  const prompt = `Create a ${req.days}-day trip plan for ${req.destination} starting ${req.startDate}.
Preferences: ${req.preferences.join(", ") || "general sightseeing"}.
${savedPlacesText}

Return ONLY a JSON array (no markdown, no explanation) with this exact structure:
[
  {
    "dayNumber": 1,
    "date": "${req.startDate}",
    "activities": [
      {
        "placeName": "Place Name",
        "lat": 50.0875,
        "lng": 14.4213,
        "timeSlot": "09:00-11:00",
        "notes": "Brief description or tip",
        "order": 1
      }
    ]
  }
]

Include 4-6 activities per day. Use real coordinates. Mix the preferences. Optimize route to minimize travel between spots each day.`;

  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.1:8b",
        prompt,
        stream: false,
        options: { temperature: 0.7 },
      }),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await res.json();
    const text = data.response;

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found in response");

    return JSON.parse(jsonMatch[0]) as TripPlanDay[];
  } catch (error) {
    console.error("AI planner error, using fallback:", error);
    return generateFallbackPlan(req);
  }
}

function generateFallbackPlan(req: PlanRequest): TripPlanDay[] {
  const days: TripPlanDay[] = [];
  const timeSlots = [
    "09:00-10:30",
    "11:00-12:30",
    "13:00-14:30",
    "15:00-16:30",
    "17:00-18:30",
    "19:30-21:00",
  ];

  for (let d = 0; d < req.days; d++) {
    const date = new Date(req.startDate);
    date.setDate(date.getDate() + d);

    const activities = timeSlots.map((slot, i) => {
      const saved = req.savedPlaces[d * timeSlots.length + i];
      return {
        placeName: saved?.name || `Explore ${req.destination} - Activity ${i + 1}`,
        lat: saved?.lat || 0,
        lng: saved?.lng || 0,
        timeSlot: slot,
        notes: saved ? "From your saved places" : "Discover local spots",
        order: i + 1,
      };
    });

    days.push({
      dayNumber: d + 1,
      date: date.toISOString().split("T")[0],
      activities,
    });
  }
  return days;
}
