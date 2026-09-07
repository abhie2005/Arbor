import { redirect } from "next/navigation";

import { SignInForm } from "@/components/sign-in-form";
import { devAuthEnabled, getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/**
 * Sign in.
 *
 * The demo credentials are printed on the page in development only. A seeded
 * workspace whose password lives in the seed script's output is a workspace
 * nobody can get into an hour later, and the alternative — putting them in the
 * README — is how demo passwords end up in production.
 */
export default async function LoginPage() {
  const viewer = await getCurrentUser();
  if (viewer) redirect("/");

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-mark">A</div>
        <h1>Arbor</h1>
        <p className="login-sub">A dense, keyboard-driven work platform.</p>

        <SignInForm demoPassword={devAuthEnabled() ? "arbor-demo-2026" : null} />
      </div>
    </main>
  );
}
