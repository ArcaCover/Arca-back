import { describe, expect, it } from 'vitest';
import { DOMAIN_LABELS, DomainKey } from '@arca/contracts';

describe('DOMAIN_LABELS', () => {
  it('names the six domains of the demo bank and bank 4.0 categories', () => {
    expect(DOMAIN_LABELS).toEqual({
      governance: 'AI Governance & Policy',
      tools: 'AI Tool Environment',
      oversight: 'Human Oversight & Review',
      data_protection: 'Data Protection & Confidentiality',
      training: 'Training & Competency',
      incident_preparedness: 'Incident Preparedness',
      ai_data_governance: 'AI & Data Governance',
      professional_standing: 'Professional Standing',
      firm_maturity: 'Firm Maturity',
      firm_profile: 'About your firm',
    });
    expect(Object.keys(DOMAIN_LABELS)).toEqual(DomainKey.options);
    // Shared by every consumer, so none of them may change it.
    expect(Object.isFrozen(DOMAIN_LABELS)).toBe(true);
  });
});
