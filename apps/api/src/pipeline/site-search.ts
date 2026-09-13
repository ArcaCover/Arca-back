import type { CrawledPage } from './crawler.js';

export type SearchPassage = { url: string; start: number; end: number; text: string };
// Folds case and accents one UTF-16 unit at a time, so offsets in the folded text match the original text.
const fold = (value: string) => value.split('').map(unit => unit.normalize('NFD')[0]!.toLowerCase()[0]!).join('');

/** Verbatim windows around each term over the full text already read, including what the corpus budget dropped. */
export function findPassages(pages: CrawledPage[], terms: string[], options: { maxPassages?: number; radius?: number } = {}): SearchPassage[] {
  const maxPassages = options.maxPassages ?? 12, radius = options.radius ?? 300;
  const needles = [...new Set(terms.map(term => fold(term.trim())).filter(term => term.length >= 2))];
  const passages: SearchPassage[] = [];
  for (const page of pages) {
    const haystack = fold(page.text), ranges: Array<[number, number]> = [];
    for (const needle of needles) {
      for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
        ranges.push([Math.max(0, index - radius), Math.min(page.text.length, index + needle.length + radius)]);
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
    }
    for (const [start, end] of merged) passages.push({ url: page.url, start, end, text: page.text.slice(start, end) });
  }
  return passages.slice(0, maxPassages);
}
