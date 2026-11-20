import type { EvidenceReference, WebsiteData } from '@arca/contracts';
import { attorneyStatesReference, compareText, normalizeName, stateCode, statesIn } from '@arca/scoring';
import type { CrawledPage } from './crawler.js';

/**
 * The states the firm's own site shows each attorney licensed in, read by rule from the pages the scan fetched (DN-12 §15).
 * Two layouts are read:
 * - A roster card: the name, a title ending in a legal role, then two-letter codes ("Jordan HaleManaging Partner FL · GA").
 *   Every code must be a state's, and the role keeps a "Jane Roe, PA" (professional association) from reading as one.
 * - The attorney's own profile page, the one whose address names them ("/attorney/adam-mott/"): "licensed to practice
 *   law in Texas and Virginia", "admitted in Ohio", "member of the Florida Bar", "State Bar of Texas", "Florida Bar No.",
 *   and a "Licensed to Practice Law in:" or "Bar Admissions:" heading followed by one state per line. Only full state
 *   names count there, and admissions to federal courts ("Southern District of New York") are not licences.
 * One reference per attorney, at the first page (in code-unit order) that showed a state; the excerpt joins all the
 * states the pages showed. Callers leave news and blog pages out.
 */
export function attorneyStates(pages: CrawledPage[], team: NonNullable<WebsiteData['team_members']>): EvidenceReference[] {
  const found = new Map<string, { name: string; states: Set<string>; urls: Set<string> }>();
  const ordered = [...pages].sort((a, b) => compareText(a.url, b.url));
  for (const { full_name: name } of team) {
    const key = normalizeName(name);
    if (!key) continue;
    for (const page of ordered) {
      const states = [...rosterStates(page.text, name), ...(isProfileOf(page.url, name) ? profileStates(page.text) : [])];
      if (!states.length) continue;
      const entry = found.get(key) ?? { name, states: new Set<string>(), urls: new Set<string>() };
      for (const state of states) entry.states.add(state);
      entry.urls.add(page.url);
      found.set(key, entry);
    }
  }
  return [...found.entries()].sort(([a], [b]) => compareText(a, b))
    .map(([, entry]) => attorneyStatesReference(entry.name, entry.states, [...entry.urls].sort(compareText)[0]!));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROLE = /\b(?:attorney|lawyer|partner|associate|counsel|litigation|shareholder|principal|founder|member|esq\.?)$/i;
const TITLE_WORD = String.raw`(?:[A-Z][A-Za-z.'’-]*|of|and|the|&)`;

function rosterStates(text: string, name: string): string[] {
  const person = name.trim().split(/\s+/).map(escape).join(String.raw`\s+`);
  // Name, an optional comma or dash, a title on one line, a space or a bar, then codes joined by a middle dot, bullet,
  // bar, slash or comma, and nothing that continues the last code as a word.
  const card = new RegExp(String.raw`${person}\s*(?:[,–—-]\s*)?(${TITLE_WORD}(?:[ \t]+${TITLE_WORD}){0,5}?)` +
    String.raw`(?:[ \t]*[|–—][ \t]*|\s+)([A-Z]{2}(?:[ \t]*[·•|/,][ \t]*[A-Z]{2})*)(?![a-z])`, 'g');
  const states: string[] = [];
  for (const match of text.matchAll(card)) {
    if (!ROLE.test(match[1]!.trim())) continue;
    const codes = match[2]!.split(/[·•|/,]/).map(code => code.trim());
    if (codes.every(code => stateCode(code) === code)) states.push(...codes);
  }
  return states;
}

function isProfileOf(url: string, name: string): boolean {
  let slug: string[];
  try { slug = decodeURIComponent(new URL(url).pathname).toLowerCase().split('/').filter(Boolean).at(-1)?.split(/[-_]+/) ?? []; }
  catch { return false; }
  const tokens = normalizeName(name).split(' ');
  return tokens.length >= 2 && slug.includes(tokens.at(-1)!) && tokens.slice(0, -1).some(token => slug.includes(token));
}

// A sentence that admits the attorney somewhere, and the line headings that list one state per line below them.
const ADMITTED = /\b(?:licensed|admitted)(?:\s+to\s+practice(?:\s+law)?)?\s+in\b[ \t]*:?[ \t]*([^\n.]*)/gi;
const ADMISSIONS = /\bbar\s+admissions?\b[ \t]*:?[ \t]*([^\n]*)/gi;
const CAPITALIZED = String.raw`((?:[A-Z][a-z]+\s+){0,2}[A-Z][a-z]+)`;
const BAR_NAMES = [new RegExp(String.raw`\b(?:member\s+of|admitted\s+to)\s+the\s+${CAPITALIZED}\s+(?:State\s+)?Bar\b`, 'g'),
  new RegExp(String.raw`\bState\s+Bar\s+of\s+${CAPITALIZED}`, 'g'),
  new RegExp(String.raw`\b${CAPITALIZED}\s+(?:State\s+)?Bar\s+(?:No\b|Number|#|Association|Card)`, 'g')];
// Federal courts sit in a state without licensing anyone there. The District of Columbia is a jurisdiction of its own.
const FEDERAL = /\b(?:district(?!\s+of\s+columbia)|circuit|federal|bankruptcy|united\s+states)\b|\bu\.\s?s\./i;

const licences = (text: string) => text.split(/[,;·]|\band\b/i).filter(part => !FEDERAL.test(part)).flatMap(statesIn);

function profileStates(text: string): string[] {
  const states: string[] = [];
  for (const pattern of [ADMITTED, ADMISSIONS]) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]!.trim()) { states.push(...licences(match[1]!)); continue; }
      // A heading: the lines below it, while each one starts with a state ("Texas — State Bar of Texas No. 1").
      const lines = text.slice(match.index! + match[0].length).split('\n').map(line => line.trim());
      let index = 0;
      while (index < lines.length && !lines[index]) index++;
      for (; index < lines.length; index++) {
        const code = stateCode(lines[index]!.split(/\s+[—–-]\s+|,|\(/)[0]!.trim());
        if (!code) break;
        states.push(code);
      }
    }
  }
  for (const pattern of BAR_NAMES) for (const match of text.matchAll(pattern)) states.push(...statesIn(match[1]!));
  return states;
}
