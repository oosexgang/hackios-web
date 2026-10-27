import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HakiOS",
    short_name: "HakiOS",
    description: "The Darwin kernel on Android phones: documentation, devices, FAQ.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbfaf9",
    theme_color: "#161312",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
