const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const PRACTICE_AREAS = [
  { area: 'Criminal Defense', value: 2, aliases: ['criminal defense', 'criminal law'] },
  { area: 'Immigration', value: 1.8, aliases: ['immigration', 'immigration law'] },
  { area: 'Medical Malpractice', value: 1.7, aliases: ['medical malpractice'] },
  { area: 'Personal Injury', value: 1.6, aliases: ['personal injury'] },
  { area: 'IP/Patents', value: 1.4, aliases: ['ip', 'patents', 'intellectual property', 'ip patents'] },
  { area: 'Family Law', value: 1.3, aliases: ['family law', 'family'] },
  { area: 'Securities', value: 1.3, aliases: ['securities', 'securities law'] },
  { area: 'Commercial Litigation', value: 1.2, aliases: ['commercial litigation'] },
  { area: 'Employment Law', value: 1.15, aliases: ['employment law', 'employment'] },
  { area: 'Bankruptcy', value: 1.1, aliases: ['bankruptcy'] },
  { area: 'Corporate/M&A', value: 1, aliases: ['corporate', 'corporate law', 'corporate m a', 'mergers and acquisitions', 'm a'] },
  { area: 'Real Estate', value: .85, aliases: ['real estate', 'real estate law'] },
  { area: 'Tax/Regulatory', value: .75, aliases: ['tax', 'tax law', 'regulatory', 'tax regulatory'] },
] as const;
export function normalizeAreas(areas: string[] | null): string[] | null {
  if (areas === null) return null;
  return [...new Set(areas.map(area => {
    const key = normalize(area);
    return PRACTICE_AREAS.find(item => item.aliases.some(alias => normalize(alias) === key))?.area ?? key;
  }).filter(Boolean))].sort();
}
export function jaccard(left: string[] | null, right: string[] | null): number | null {
  const a = normalizeAreas(left), b = normalizeAreas(right);
  if (!a?.length || !b?.length) return null;
  const union = new Set([...a, ...b]);
  return a.filter(value => b.includes(value)).length / union.size;
}
