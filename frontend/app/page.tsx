"use client";

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Health = { status: string; time: string };

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setHealth)
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <main>
      <h1>PH26 Team 34</h1>
      <p>
        Backend: <code>{API_URL}</code>
      </p>
      {health && <p>✅ El backend responde ({health.status}, {health.time})</p>}
      {error && <p>❌ El backend no responde: {error}</p>}
      {!health && !error && <p>Consultando backend…</p>}
    </main>
  );
}
