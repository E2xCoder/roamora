import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import LoginForm from "./LoginForm";

/**
 * `useSearchParams` opts a route into client-side rendering, so the form lives
 * in a child component behind a Suspense boundary; without one the static
 * export of this page fails.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh flex items-center justify-center">
          <Loader2 size={22} className="animate-spin text-primary" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
