import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { fullAddress, rateText, site } from "@/lib/site/content";

export const alt = site.meta.ogAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const ball = await readFile(join(process.cwd(), "public", "brand", "ball.png"));
  const src = `data:image/png;base64,${ball.toString("base64")}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#0a0a0a",
          padding: "0 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", color: "#f4f1ec" }}>
          <div style={{ display: "flex", fontSize: 30, color: "#f47b20", letterSpacing: 4, textTransform: "uppercase" }}>
            {site.name}
          </div>
          <div style={{ display: "flex", fontSize: 92, fontWeight: 800, lineHeight: 1.02, marginTop: 24, width: 600 }}>
            {site.hero.heading}
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#f6e7d2", marginTop: 32 }}>
            {rateText} per table
          </div>
          <div style={{ display: "flex", fontSize: 26, color: "#aaa49c", marginTop: 12 }}>{fullAddress}</div>
        </div>
        <div
          style={{
            width: 400,
            height: 400,
            borderRadius: 200,
            background: "#f47b20",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/alt-text -- drawn into a PNG, not rendered as HTML */}
          <img src={src} width={290} height={290} />
        </div>
      </div>
    ),
    size,
  );
}
