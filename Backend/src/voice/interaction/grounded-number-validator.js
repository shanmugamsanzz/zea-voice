const maximumText = 8_000;

function text(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximumText);
}

const orderedMarkerPattern = /(^|[\s,;])(\d{1,2})[.)](?=\s*[\p{L}\p{M}])/gu;

function canonicalNumber(value) {
  let normalized = String(value ?? '').replace(/[^\d.,:%/-]/gu, '');
  if (!normalized) return null;
  const suffix = normalized.endsWith('%') ? '%' : '';
  normalized = normalized.replace(/%/gu, '');
  // The token matcher may include sentence punctuation immediately after a
  // number (for example `3,200.00.`). Remove only the final punctuation mark;
  // decimal zeroes remain available for canonicalization below.
  normalized = normalized.replace(/[.,]$/u, '');
  // Dates, ratios and times are facts too. Preserve their component
  // boundaries instead of collapsing 20/08 into the unrelated number 2008.
  if (normalized.includes('/')) {
    return normalized.split(/([/])/u).map((part) => (
      /^\d+$/u.test(part) ? String(Number(part)) : part
    )).join('') + suffix;
  }
  if (normalized.includes('-')) {
    const endpoints = normalized.split('-').map((part) => canonicalNumber(part)).filter(Boolean);
    return endpoints.length > 1 ? `${endpoints.join('-')}${suffix}` : endpoints[0] ?? null;
  }
  // Spoken time commonly omits zero minutes ("8 AM") while published
  // evidence uses clock notation ("08:00 AM"). Canonicalize only an exact
  // zero-minute clock to its hour; non-zero minutes remain exact facts.
  if (normalized.includes(':')) {
    const parts = normalized.split(':');
    if (parts.length === 2 && /^\d+$/u.test(parts[0]) && /^\d+$/u.test(parts[1])) {
      const hour = String(Number(parts[0]));
      const minute = String(Number(parts[1]));
      return `${hour}${minute === '0' ? '' : `:${minute}`}${suffix}`;
    }
  }
  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  const separator = Math.max(lastComma, lastDot);
  if (separator >= 0) {
    const fractionalDigits = normalized.length - separator - 1;
    const separatorCharacter = normalized[separator];
    const occurrences = normalized.split(separatorCharacter).length - 1;
    const decimal = fractionalDigits > 0 && fractionalDigits <= 2
      && (occurrences === 1 || separator === Math.max(lastComma, lastDot));
    if (decimal) {
      const integer = normalized.slice(0, separator).replace(/[.,]/gu, '') || '0';
      const fraction = normalized.slice(separator + 1).replace(/[.,]/gu, '')
        .replace(/0+$/u, '');
      return `${String(Number(integer))}${fraction ? `.${fraction}` : ''}${suffix}`;
    }
    normalized = normalized.replace(/[.,]/gu, '');
  }
  return `${String(Number(normalized))}${suffix}`;
}

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
  const result = new Set();
  for (const matched of stripOrderedListMarkers(value).match(/\p{Sc}?\s*\d[\d,.:%/-]*/gu) ?? []) {
    const canonical = canonicalNumber(matched);
    if (!canonical) continue;
    result.add(canonical);
    // A published range contains two independently speakable authoritative
    // values. Preserve the range and expose its endpoints without deriving
    // any new number.
    if (canonical.includes('-')) {
      for (const endpoint of canonical.split('-')) if (endpoint) result.add(endpoint);
    }
  }
  return result;
}

/**
 * Extract numeric facts only from the caller-facing fields of the exact
 * hydrated records supplied to the LLM. Runtime IDs and revision metadata are
 * deliberately excluded so they can never authorize a spoken number.
 */
export function groundedNumbersFromSources(sources = []) {
  const result = new Set();
  for (const source of sources) {
    let structured = '';
    try {
      structured = JSON.stringify({
        canonicalName: source?.canonicalName ?? null,
        content: source?.content ?? null,
        facts: source?.facts ?? null,
        authoritativeData: source?.authoritativeData ?? null,
      });
    } catch {
      structured = String(source?.content ?? '');
    }
    for (const number of groundedNumbers(structured)) result.add(number);
  }
  return result;
}
