// Unicode letters/numbers permit all configured languages without phrase rules.
export function hasSpeakableText(value) {
  return /[\p{L}\p{N}]/u.test(String(value ?? ''));
}
