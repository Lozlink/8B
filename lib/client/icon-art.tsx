import { ImageResponse } from "next/og";

/** Renders the app icon (a black 8 ball with a cream spot on the venue's orange) at any square size. Shared by every icon route. */
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
          background: "#f47b20",
        }}
      >
        <div
          style={{
            width: ball,
            height: ball,
            borderRadius: ball,
            background: "#0a0a0a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `${Math.max(2, Math.round(px * 0.02))}px solid #f6e7d2`,
          }}
        >
          <div
            style={{
              width: badge,
              height: badge,
              borderRadius: badge,
              background: "#f6e7d2",
              color: "#0a0a0a",
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
