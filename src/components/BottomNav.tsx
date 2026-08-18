"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Map, Compass, CalendarDays, Mountain, Upload } from "lucide-react";

const navItems = [
  { href: "/", label: "Harita", icon: Map },
  { href: "/explore", label: "Kesfet", icon: Compass },
  { href: "/plan", label: "Gezi", icon: CalendarDays },
  { href: "/hiking", label: "Hiking", icon: Mountain },
  { href: "/import", label: "Import", icon: Upload },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <>
      {/* Mobile: bottom bar */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 glass-panel border-t border-glass-border">
        <div className="flex items-center justify-around h-16 px-2">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${
                  isActive
                    ? "text-primary"
                    : "text-muted hover:text-foreground"
                }`}
              >
                <div className={`p-1.5 rounded-xl transition-all ${isActive ? "bg-primary-light" : ""}`}>
                  <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
                </div>
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Desktop: slim side rail */}
      <nav className="hidden md:flex fixed inset-y-0 left-0 z-50 w-20 flex-col items-center py-6 gap-1 glass-panel border-r border-glass-border">
        <div className="mb-6">
          <div className="w-10 h-10 rounded-2xl gradient-primary flex items-center justify-center">
            <span className="text-white font-bold text-lg">R</span>
          </div>
        </div>

        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`group flex flex-col items-center gap-1 p-2.5 rounded-2xl transition-all w-16 ${
                isActive
                  ? "bg-primary-light text-primary"
                  : "text-muted hover:text-foreground hover:bg-card-hover"
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
