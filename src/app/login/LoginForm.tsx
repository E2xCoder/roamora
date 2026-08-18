"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Lock, ArrowRight } from "lucide-react";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? `Giriş başarısız (${res.status})`);
        return;
      }

      // Only same-origin relative paths, so a crafted `next` cannot redirect
      // the browser to an external site after login.
      const next = params.get("next");
      const safeNext =
        next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

      router.replace(safeNext);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sunucuya ulaşılamadı");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-3xl gradient-primary flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-xl">R</span>
          </div>
          <h1 className="text-xl font-bold">Roamora</h1>
          <p className="text-xs text-muted mt-1">
            Devam etmek için parolanı gir
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center bg-card border-2 border-card-border rounded-2xl overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_4px_var(--primary-glow)] transition-all">
            <Lock size={16} className="ml-4 text-muted shrink-0" />
            <label htmlFor="password" className="sr-only">
              Parola
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Parola"
              autoFocus
              autoComplete="current-password"
              className="flex-1 min-w-0 px-3 py-3.5 bg-transparent text-sm focus:outline-none"
            />
          </div>

          {error && (
            <p className="text-xs text-danger px-1" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full flex items-center justify-center gap-2 px-4 py-3.5 gradient-primary text-white rounded-2xl text-sm font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {submitting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            Giriş yap
          </button>
        </form>
      </div>
    </div>
  );
}
