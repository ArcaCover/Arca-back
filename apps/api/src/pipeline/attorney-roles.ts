const plain = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ');

// Explicit statements that a person is not a practising attorney in the firm's jurisdiction win over any label.
const NOT_ATTORNEY = /no es abogad|not an? (attorney|lawyer)|paralegal|coordinador|gerente|manager|assistant|asistente|atencion al cliente|customer service|recepcion|receptionist|secretari|unicamente en (?!florida)|only in (?!florida)/;
const ATTORNEY = /\b(attorney|lawyer|abogad[oa]|partner|socio|counsel|esq)\b/;

/** Text about one person: from their name up to the next listed person, so neighbours' roles do not leak in. */
export function personEvidence(quotes: string[], name: string, otherNames: string[]): string {
  const target = plain(name);
  return quotes.flatMap(quote => {
    const text = plain(quote), start = text.indexOf(target);
    if (start < 0) return [];
    const ends = otherNames.map(other => text.indexOf(plain(other), start + target.length)).filter(index => index > start);
    return [text.slice(start, Math.min(start + 240, ...ends))];
  }).join(' | ');
}

/** The model's declared role is never sufficient on its own; the cited evidence has to carry the role. */
export function classifyRole(input: { role: unknown; title: unknown; evidence: string }): 'attorney' | 'staff' | 'unclear' {
  const described = plain(`${typeof input.title === 'string' ? input.title : ''} ${input.evidence}`);
  if (NOT_ATTORNEY.test(described)) return 'staff';
  if (ATTORNEY.test(described)) return 'attorney';
  return /\b(staff|empleado|employee)\b/.test(plain(String(input.role ?? ''))) ? 'staff' : 'unclear';
}
