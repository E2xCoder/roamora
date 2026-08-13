"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Map,
  Compass,
  CalendarDays,
  Mountain,
  Upload,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/", label: "Harita", icon: Map },
  { href: "/explore", label: "Keşfet", icon: Compass },
  { href: "/plan", label: "Gezi Planı", icon: CalendarDays },
  { href: "/hiking", label: "Hiking", icon: Mountain },
  { href: "/import", label: "Import", icon: Upload },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-sidebar-bg text-sidebar-text"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-sidebar-bg text-sidebar-text transform transition-transform duration-200 md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-6">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-primary">Roam</span>ora
          </h1>
          <p className="text-xs text-muted mt-1">Your travel companion</p>
        </div>

        <nav className="px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary text-white"
                    : "hover:bg-white/10 text-sidebar-text"
                }`}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}
