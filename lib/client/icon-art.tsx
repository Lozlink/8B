import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/** The 8 ball from the venue's logo, cut out on its own (public/brand/ball.png). Read once per process. */
let ball: Promise<string> | null = null;
function ballDataUri(): Promise<string> {
  ball ??= readFile(join(process.cwd(), "public", "brand", "ball.png")).then((b) => `data:image/png;base64,${b.toString("base64")}`);
  return ball;
}

/**
 * Renders the app icon (the logo's 8 ball on the venue's orange) at any square size. Shared by every
 * icon route. The ball fills 72% of the square, inside the middle 80% a maskable icon must keep clear,
 * so the same picture is safe when a launcher crops it to a circle.
 */
export async function renderIcon(px: number): Promise<ImageResponse> {
  const size = Math.round(px * 0.72);
  const src = await ballDataUri();
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
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- drawn into a PNG, not rendered as HTML */}
        <img src={src} width={size} height={size} />
      </div>
    ),
    { width: px, height: px },
  );
}
