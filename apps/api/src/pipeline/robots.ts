import { createRequire } from 'node:module';
import { fetchPublicText } from './network.js';

export const USER_AGENT = 'ArcaBot/1.0';
type RobotsRules = { isAllowed(url: string, agent: string): boolean | undefined; getSitemaps(): string[] };
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, text: string) => RobotsRules;

export async function robotsRules(origin: string, signal: AbortSignal, fetchText = fetchPublicText): Promise<RobotsRules> {
  const url = `${origin}/robots.txt`, response = await fetchText(url, signal);
  if (response.status === 404 || response.status === 410) return robotsParser(url, '');
  if (response.status < 200 || response.status >= 300) throw new Error('ROBOTS_UNAVAILABLE');
  return robotsParser(url, response.text);
}

export async function robotsAllows(url: string, signal: AbortSignal, fetchText = fetchPublicText): Promise<boolean> {
  return (await robotsRules(new URL(url).origin, signal, fetchText)).isAllowed(url, USER_AGENT) !== false;
}
