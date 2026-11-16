import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "8 Ball Lounge Timer",
    short_name: "8 Ball Timer",
    description: "Table timer for 8 Ball Lounge staff.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b100e",
    theme_color: "#0b100e",
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
