import Link from "next/link";
import type { ReactNode } from "react";

export default function DuranteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <nav aria-label="Evidencia del proyecto" style={{ maxWidth: "88rem", margin: "0 auto", padding: "0 clamp(1rem, 3vw, 2rem) 2rem" }}>
        <Link href="/central/validacion" className="btn btn--secondary btn--md">Validación histórica</Link>
      </nav>
    </>
  );
}
