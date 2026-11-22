import { ImageResponse } from "next/og";
import { DROP_PATH } from "@/lib/drop";
import { EDITABLES } from "@/lib/paleta";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

const principal = EDITABLES.find((c) => c.id === "principal")!.defecto;

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width={(64 * 20) / 27} height={64} viewBox="0 0 20 27">
          <path d={DROP_PATH} fill={principal} />
        </svg>
      </div>
    ),
    size,
  );
}
