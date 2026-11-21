import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PH26 Team 34",
  description: "Platanus Hack 26 - Team 34",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>{children}</body>
    </html>
  );
}
