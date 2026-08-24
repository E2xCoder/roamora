import { redirect } from "next/navigation";

/** The Plan experience now lives at "/" (the redesigned home screen) — this keeps old links/bookmarks working. */
export default function PlanRedirect() {
  redirect("/");
}
