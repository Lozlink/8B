import { ImageResponse } from "next/og";

/** Renders the app icon (an 8 ball on felt) at any square size. Shared by every icon route. */
export function renderIcon(px: number): ImageResponse {
  const ball = Math.round(px * 0.7);
  const badge = Math.round(ball * 0.46);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1d5a40",
        }}
      >
        <div
          style={{
            width: ball,
            height: ball,
            borderRadius: ball,
            background: "#0b0d0c",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `${Math.max(2, Math.round(px * 0.02))}px solid #d9b15a`,
          }}
        >
          <div
            style={{
              width: badge,
              height: badge,
              borderRadius: badge,
              background: "#f4f1e8",
              color: "#0b0d0c",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: Math.round(badge * 0.78),
              fontWeight: 700,
            }}
          >
            8
          </div>
        </div>
      </div>
    ),
    { width: px, height: px },
  );
}
