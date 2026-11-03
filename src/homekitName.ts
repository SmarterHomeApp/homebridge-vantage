const HAP_NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]*[\p{L}\p{N}])?$/u;

/** HomeKit/HAP 2.3 accessory names must start and end with a letter or number. */
export function sanitizeHomeKitName(raw: string, fallback = 'Vantage'): string {
  let name = String(raw ?? '').normalize('NFC');
  name = name.replace(/[()]/g, ' ');
  name = name.replace(/[^\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]+/gu, ' ');
  name = name.replace(/\p{Zs}+/gu, ' ').trim();
  name = name.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').trim();

  if (name && HAP_NAME_PATTERN.test(name)) {
    return name;
  }

  name = name.replace(/[^\p{L}\p{N}\p{Zs}]+/gu, ' ').replace(/\p{Zs}+/gu, ' ').trim();
  return name || fallback;
}
