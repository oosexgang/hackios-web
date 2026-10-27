// The documentation's table of contents: the sections and pages of content/docs (copied from the hakios repository's docs/ by
// `npm run docs`), in the order a reader needs them. A page not listed here is still served, and reached from the pages that link it.
export type NavItem = { title: string; slug: string };
export type NavSection = { title: string; items: NavItem[] };

export const NAV: NavSection[] = [
  {
    title: "Getting started",
    items: [
      { title: "Overview", slug: "" },
      { title: "Three ways in", slug: "getting-started" },
      { title: "QEMU", slug: "getting-started/qemu" },
      { title: "On the phone", slug: "getting-started/phone" },
      { title: "Building from source", slug: "getting-started/building" },
      { title: "Windows", slug: "windows" },
    ],
  },
  {
    title: "Concepts",
    items: [
      { title: "Architecture", slug: "concepts/architecture" },
      { title: "Configuration", slug: "configs" },
      { title: "Drivers in the configuration", slug: "drivers-config" },
      { title: "Versioning", slug: "versioning" },
      { title: "UEFI boot", slug: "uefi-boot" },
      { title: "Installing (design)", slug: "install" },
      { title: "Installing, safely", slug: "install-safe" },
    ],
  },
  {
    title: "Porting",
    items: [
      { title: "Port a device", slug: "porting" },
      { title: "How the repositories fit", slug: "porting/repositories" },
      { title: "Writing a driver", slug: "porting/drivers" },
    ],
  },
  {
    title: "Devices",
    items: [
      { title: "All devices", slug: "devices" },
      { title: "POCO X5 Pro 5G", slug: "devices/redwood" },
      { title: "QEMU", slug: "devices/qemu" },
    ],
  },
  {
    title: "GPU, Metal, cellular",
    items: [
      { title: "Metal plan", slug: "metal-plan" },
      { title: "The shader compiler", slug: "air" },
      { title: "AIR report", slug: "air-report" },
      { title: "Cellular", slug: "cellular" },
    ],
  },
  {
    title: "Reference",
    items: [
      { title: "Drivers", slug: "reference/drivers" },
      { title: "Boot arguments", slug: "boot-args" },
      { title: "Commands", slug: "reference/tools" },
    ],
  },
  {
    title: "Project",
    items: [
      { title: "Comparison", slug: "comparison" },
      { title: "Driver reviews", slug: "driver-review" },
      { title: "Legal review", slug: "legal-review" },
    ],
  },
];
