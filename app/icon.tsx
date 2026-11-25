import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/**
 * The browser-tab icon: the 8 ball from the logo (public/brand/ball.png) on a transparent
 * background. app/favicon.ico is the same picture for browsers that only look for that file.
 * The Home Screen icons (apple-icon, icons/192, icons/512) keep the orange square: iOS fills a
 * transparent icon with black, and a black ball would disappear into it.
 */
export default async function Icon() {
  const ball = await readFile(join(process.cwd(), "public", "brand", "ball.png"));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- drawn into a PNG, not rendered as HTML */}
        <img src={`data:image/png;base64,${ball.toString("base64")}`} width={64} height={64} />
      </div>
    ),
    size,
  );
}
