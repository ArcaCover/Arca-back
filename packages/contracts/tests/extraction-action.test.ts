import { describe, expect, it } from 'vitest';
import { ExtractionAction } from '../src/index.js';

// The action only steers the next round. A longer list than the loop uses is trimmed, never
// rejected: a rejection costs a full repair call (about 12 s) to learn nothing.
describe('ExtractionAction', () => {
  const fields = ['firm_name', 'firm_aliases', 'city', 'county', 'address_street', 'phone', 'office_count',
    'attorneys', 'attorney_count', 'team_page_quality'];

  it('keeps the first eight target fields', () => {
    const action = ExtractionAction.parse({ type: 'read_sitemap', targetFields: fields, reason: 'find team page' });
    expect(action.targetFields).toEqual(fields.slice(0, 8));
  });

  it('keeps the first four pages and the first two documents', () => {
    const pages = ExtractionAction.parse({ type: 'fetch_pages', linkIds: ['a', 'b', 'c', 'd', 'e', 'f'], targetFields: ['city'], reason: 'r' });
    expect(pages.type === 'fetch_pages' && pages.linkIds).toEqual(['a', 'b', 'c', 'd']);
    const documents = ExtractionAction.parse({ type: 'read_document', linkIds: ['a', 'b', 'c'], targetFields: ['privacy_policy'], reason: 'r' });
    expect(documents.type === 'read_document' && documents.linkIds).toEqual(['a', 'b']);
  });

  it('keeps the first six search terms', () => {
    const search = ExtractionAction.parse({ type: 'find_in_site', terms: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg'], targetFields: ['ai_policy'], reason: 'r' });
    expect(search.type === 'find_in_site' && search.terms).toHaveLength(6);
  });

  it('still accepts finishing', () => {
    expect(ExtractionAction.parse({ type: 'finish', reason: 'enough evidence' })).toEqual({ type: 'finish', reason: 'enough evidence' });
  });

  it('still rejects an empty or malformed action', () => {
    expect(ExtractionAction.safeParse({ type: 'read_sitemap', targetFields: [], reason: 'r' }).success).toBe(false);
    expect(ExtractionAction.safeParse({ type: 'read_sitemap', targetFields: ['not_a_field'], reason: 'r' }).success).toBe(false);
  });
});
