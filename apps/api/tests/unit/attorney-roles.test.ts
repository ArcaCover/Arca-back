import { describe, expect, it } from 'vitest';
import { classifyRole, personEvidence } from '../../src/pipeline/attorney-roles.js';

const team = 'Melina Ocampo\nCoordinadora de casos humanitarios\n(Abogada con licencia para ejercer únicamente en Colombia)\n'
  + 'Diana Posada\nParalegal en inmigración\n(Abogada con licencia para ejercer únicamente en Colombia)\n'
  + 'Lorraine Chilson\nGerente Administrativa\n(No es abogada)';

describe('attorney role classification', () => {
  it('cuts a person evidence window at the next listed person', () => {
    const window = personEvidence([team], 'Melina Ocampo', ['Diana Posada', 'Lorraine Chilson']);
    expect(window).toContain('coordinadora');
    expect(window).not.toContain('paralegal');
  });

  it('lets explicit non-attorney markers override the role the model declared', () => {
    for (const [name, others] of [['Melina Ocampo', ['Diana Posada']], ['Diana Posada', ['Lorraine Chilson']],
      ['Lorraine Chilson', []]] as const) {
      const evidence = personEvidence([team], name, [...others]);
      expect(classifyRole({ role: 'Attorney', title: null, evidence })).toBe('staff');
    }
  });

  it('keeps a Florida attorney and a site-labelled lawyer as attorneys', () => {
    expect(classifyRole({ role: 'Attorney', title: 'Abogado de Inmigración',
      evidence: 'Carlos Mauricio Duque es un abogado licenciado en Florida y Colombia.' })).toBe('attorney');
    expect(classifyRole({ role: null, title: 'Lawyer', evidence: 'Carmen Gallardo Lawyer' })).toBe('attorney');
  });

  it('does not promote someone with no role evidence', () => {
    expect(classifyRole({ role: 'Attorney', title: null, evidence: 'Carolina Bonilla' })).toBe('unclear');
  });

  it('gives a nameless entry no evidence and no attorney role', () => {
    const evidence = personEvidence(['Carmen Gallardo Lawyer'], '', ['Carmen Gallardo']);
    expect(evidence).toBe('');
    expect(classifyRole({ role: 'Attorney', title: null, evidence })).toBe('unclear');
  });

  it('gives a whitespace-only name no evidence and no attorney role', () => {
    const evidence = personEvidence(['Carmen Gallardo Lawyer'], '   ', ['Carmen Gallardo']);
    expect(evidence).toBe('');
    expect(classifyRole({ role: 'Attorney', title: null, evidence })).toBe('unclear');
  });
});
