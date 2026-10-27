import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HakiOS",
    short_name: "HakiOS",
    description: "The Darwin kernel on Android phones: documentation, devices, FAQ.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0909",
    theme_color: "#0a0909",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
