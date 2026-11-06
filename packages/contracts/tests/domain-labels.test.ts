import { describe, expect, it } from 'vitest';
import { DOMAIN_LABELS, DomainKey } from '@arca/contracts';

describe('DOMAIN_LABELS', () => {
  it('names the six domains of the assessment the way the demo bank does', () => {
    expect(DOMAIN_LABELS).toEqual({
      governance: 'AI Governance & Policy',
      tools: 'AI Tool Environment',
      oversight: 'Human Oversight & Review',
      data_protection: 'Data Protection & Confidentiality',
      training: 'Training & Competency',
      incident_preparedness: 'Incident Preparedness',
    });
    expect(Object.keys(DOMAIN_LABELS)).toEqual(DomainKey.options);
    // Shared by every consumer, so none of them may change it.
    expect(Object.isFrozen(DOMAIN_LABELS)).toBe(true);
  });
});
