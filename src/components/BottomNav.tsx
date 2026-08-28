"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, CalendarDays, Compass, Map, Mountain, Upload, MoreHorizontal, X } from "lucide-react";

/**
 * Product audit (see git log): Roamora's core loop is "tell it where/when,
 * it plans the trip" - exactly three real flows serve that loop end to
 * end: create (Plan), view (Trips), pre-planning discovery (Explore).
 * Map/Hiking/Import are real, fully-working features, but each serves a
 * *different* workflow (manual place curation, trail lookup by name,
 * one-time data migration) than the autonomous promise this nav should
 * lead with - keeping them primary is exactly the "GIS control panel"
 * feeling the redesign is meant to move away from. Demoted to secondary,
 * not removed: nothing here is broken or low-value, it's just not the
 * first thing a new user should see.
 */
const PRIMARY_NAV = [
  { href: "/", label: "Plan", icon: Sparkles },
  { href: "/trips", label: "Trips", icon: CalendarDays },
  { href: "/explore", label: "Explore", icon: Compass },
];

const SECONDARY_NAV = [
  { href: "/map", label: "Map", icon: Map },
  { href: "/hiking", label: "Hiking", icon: Mountain },
  { href: "/import", label: "Import", icon: Upload },
];

export default function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const isSecondaryActive = SECONDARY_NAV.some((item) => pathname === item.href);

  return (
    <>
      {/* Mobile: bottom bar — 4 primary tabs + a compact "More" sheet for secondary tools */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 glass-panel border-t border-glass-border" aria-label="Ana gezinme">
        <div className="flex items-center justify-around h-16 px-2">
          {PRIMARY_NAV.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${
                  isActive ? "text-primary" : "text-muted hover:text-foreground"
                }`}
              >
                <div className={`p-1.5 rounded-xl transition-all ${isActive ? "bg-primary-light" : ""}`}>
                  <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                </div>
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
          <button
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-label="Araçlar"
            className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${
              isSecondaryActive || moreOpen ? "text-primary" : "text-muted hover:text-foreground"
            }`}
          >
            <div className={`p-1.5 rounded-xl transition-all ${isSecondaryActive || moreOpen ? "bg-primary-light" : ""}`}>
              {moreOpen ? <X size={20} strokeWidth={2.2} /> : <MoreHorizontal size={20} strokeWidth={1.8} />}
            </div>
            <span className="text-[10px] font-medium">Araçlar</span>
          </button>
        </div>

        {moreOpen && (
          <div className="absolute bottom-full right-2 mb-2 bg-card border border-card-border rounded-2xl shadow-[var(--shadow-lg)] p-2 min-w-[160px] animate-fade-in">
            {SECONDARY_NAV.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive ? "bg-primary-light text-primary" : "text-foreground hover:bg-card-hover"
                  }`}
                >
                  <Icon size={16} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}
      </nav>

      {/* Desktop: slim side rail — primary items full-weight, secondary items smaller below a divider */}
      <nav className="hidden md:flex fixed inset-y-0 left-0 z-50 w-20 flex-col items-center py-6 gap-1 glass-panel border-r border-glass-border" aria-label="Ana gezinme">
        <Link href="/" className="mb-6" aria-label="Roamora anasayfa">
          <div className="w-10 h-10 rounded-2xl gradient-brand flex items-center justify-center">
            <span className="text-white font-bold text-lg">R</span>
          </div>
        </Link>

        {PRIMARY_NAV.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`group flex flex-col items-center gap-1 p-2.5 rounded-2xl transition-all w-16 ${
                isActive ? "bg-primary-light text-primary" : "text-muted hover:text-foreground hover:bg-card-hover"
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}

        <div className="w-8 h-px bg-card-border my-3" />

        {SECONDARY_NAV.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`group flex flex-col items-center gap-1 p-2 rounded-2xl transition-all w-16 opacity-80 hover:opacity-100 ${
                isActive ? "bg-primary-light text-primary opacity-100" : "text-muted hover:text-foreground hover:bg-card-hover"
              }`}
            >
              <Icon size={17} strokeWidth={isActive ? 2.5 : 1.8} />
              <span className="text-[9px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
