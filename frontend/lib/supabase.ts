import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cliente: SupabaseClient | undefined;

export function suscribirPuntajes(escenario: string, actualizar: () => void) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const clave = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !clave) return;

  try {
    cliente ??= createClient(url, clave, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const supabase = cliente;
    const filtro = { schema: "public", table: "scores", filter: `scenario_id=eq.${escenario}` };
    const canal = supabase.channel(`ranking:${escenario}:${crypto.randomUUID()}`)
      .on("postgres_changes", { ...filtro, event: "INSERT" }, actualizar)
      .on("postgres_changes", { ...filtro, event: "UPDATE" }, actualizar)
      .subscribe((estado) => {
        // Recupera los cambios entre la petición HTTP y la conexión, incluso al reconectar.
        if (estado === "SUBSCRIBED") actualizar();
      });
    return () => { void supabase.removeChannel(canal); };
  } catch {
    // El ranking HTTP sigue disponible si falta una configuración Realtime válida.
  }
}
