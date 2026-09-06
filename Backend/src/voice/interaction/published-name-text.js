// Code-switched names may attach a local-language suffix directly to a Latin
// published name. Separate scripts, not substrings within a name (AlphaPlus).
export function publishedNameText(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/(\p{Script=Latin})(?=[\p{L}&&\P{Script=Latin}])/gv, '$1 ')
    .replace(/([\p{L}&&\P{Script=Latin}])(?=\p{Script=Latin})/gv, '$1 ');
}
