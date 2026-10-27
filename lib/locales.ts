export const LOCALES = ["en", "ru", "uk", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_LABEL: Record<Locale, string> = { en: "EN", ru: "RU", uk: "UA", zh: "中文" };
export const HTML_LANG: Record<Locale, string> = { en: "en", ru: "ru", uk: "uk", zh: "zh-CN" };
export const OG_LOCALE: Record<Locale, string> = { en: "en_US", ru: "ru_RU", uk: "uk_UA", zh: "zh_CN" };
export function isLocale(x: string): x is Locale {
  return (LOCALES as readonly string[]).includes(x);
}
