import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { rateText, site } from "@/lib/site/content";

export const alt = site.meta.ogAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** A file under public/ as a data URI, or null if it can't be read. */
async function dataUri(publicPath: string): Promise<string | null> {
  const ext = publicPath.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME[ext];
  if (!mime) return null;
  try {
    const bytes = await readFile(join(process.cwd(), "public", publicPath.replace(/^\//, "")));
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * The card shown when the site's link is shared: the lead venue photo, darkened on the left so
 * the logo and headline read over it. Without photos it falls back to the logo on black.
 */
export default async function OpenGraphImage() {
  const lead = site.photos?.[0];
  const [photo, logo] = await Promise.all([lead ? dataUri(lead.src) : Promise.resolve(null), dataUri("/brand/logo-on-dark.png")]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#0a0a0a" }}>
        {photo ? (
          // eslint-disable-next-line jsx-a11y/alt-text -- drawn into a PNG, not rendered as HTML
          <img src={photo} width={1200} height={630} style={{ position: "absolute", top: 0, left: 0, width: 1200, height: 630, objectFit: "cover" }} />
        ) : null}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            display: "flex",
            background: "linear-gradient(90deg, rgba(10,10,10,0.92) 0%, rgba(10,10,10,0.78) 42%, rgba(10,10,10,0.1) 75%)",
          }}
        />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 72px", color: "#f4f1ec" }}>
          {logo ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- drawn into a PNG, not rendered as HTML
            <img src={logo} width={257} height={100} />
          ) : null}
          <div style={{ display: "flex", fontSize: 84, fontWeight: 800, lineHeight: 1, marginTop: 36, width: 620, letterSpacing: -1 }}>
            {site.hero.heading}
          </div>
          <div style={{ display: "flex", fontSize: 34, color: "#f6e7d2", marginTop: 28 }}>
            {`${rateText} for the whole table`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
