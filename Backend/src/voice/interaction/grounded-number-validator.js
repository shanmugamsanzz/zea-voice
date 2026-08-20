const maximumText = 8_000;

function text(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximumText);
}

const orderedMarkerPattern = /(^|[\s,;])(\d{1,2})[.)](?=\s*[\p{L}\p{M}])/gu;

export function stripOrderedListMarkers(value) {
  const normalized = text(value);
  const markers = [...normalized.matchAll(orderedMarkerPattern)];
  // Ignore digits only when they form a real ordered list (1, 2, ...).
  // A lone `9 tests`, a price, date, percentage or other factual number is
  // never removed and must still be present in selected evidence.
  const ordered = markers.length >= 2 && markers.every((match, index) => (
    Number(match[2]) === index + 1
  ));
  if (!ordered) return normalized;
  return normalized.replace(orderedMarkerPattern, '$1');
}

export function groundedNumbers(value) {
  return new Set((stripOrderedListMarkers(value).match(/\p{Sc}?\s*\d[\d,.:%/-]*/gu) ?? [])
    .map((entry) => entry.replace(/[^\d]/gu, '')).filter(Boolean));
}
