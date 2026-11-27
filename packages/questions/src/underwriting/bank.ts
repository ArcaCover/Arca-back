/**
 * Bank 4.0's wording, from the question bank of arca-capa2-uw-rules.md: text and labels only. Points, knockouts and every
 * other number live in the config. `[[ ]]` clauses of the document are written as separate variants, and a slot is only
 * filled from Layer 1's data, never invented (rules §5).
 */
export type BankQuestion = {
  id: string;
  /** Plain text, or a function of the slots; a variant with an empty slot uses the plain version. */
  text: string | ((slots: Slots) => string | null);
  help: string | null;
  type: 'single_select' | 'multi_select' | 'text';
  options: Record<string, string>;
};
export type Slots = { firmName: string | null; primaryPracticeArea: string | null };

const q = (id: string, type: BankQuestion['type'], text: BankQuestion['text'], options: Record<string, string>, help: string | null = null): BankQuestion =>
  ({ id, type, text, help, options });

export const BANK_VERSION = '4.0';
export const BANK: Readonly<Record<string, BankQuestion>> = Object.freeze(Object.fromEntries([
  q('G1', 'multi_select', 'Which of these does your firm use today? Check all that apply.', {
    'G1-case-software': 'Case management software (Clio, MyCase, Smokeball, PracticePanther or similar)',
    'G1-chat-assistant': 'A chat assistant on your website',
    'G1-phone-text': 'An automated phone or text answering service',
    'G1-general-ai': 'ChatGPT, Claude, Copilot or similar',
    'G1-legal-research': 'Legal research tools like Harvey, CoCounsel, Lexis+ AI or Westlaw Precision',
    'G1-none': 'None of these', 'G1-unsure': 'Not sure' }),
  q('G2', 'multi_select', 'Where does software help your team automatically, without a person doing the work? Check all that apply.', {
    'G2-client-questions': 'Answering client questions', 'G2-intake': 'Client intake or first contact', 'G2-scheduling': 'Scheduling',
    'G2-drafting': 'Writing or drafting documents', 'G2-research': 'Legal research', 'G2-review': 'Reviewing contracts or documents',
    'G2-filings': 'Preparing court filings', 'G2-billing': 'Billing or admin', 'G2-marketing': 'Marketing',
    'G2-nowhere': 'Nowhere, people do everything', 'G2-unsure': 'Not sure' }),
  q('C1', 'multi_select', 'Has any of this happened to the firm? Check all that apply.', {
    'C1-claim-2y': 'A malpractice or professional liability claim in the last 2 years',
    'C1-claim-2to5y': 'A malpractice claim 2 to 5 years ago, no technology involved',
    'C1-claim-tech': 'A claim of any age that involved software, technology or AI',
    'C1-claims-multi': 'Two or more claims in the last 5 years',
    'C1-declined': 'An insurer declined, cancelled or did not renew in the last 3 years',
    'C1-expected': 'A claim or lawsuit you expect but that has not been filed',
    'C1-none': 'None of these', 'C1-unsure': 'Not sure' },
    'A couple of standard insurance questions.'),
  q('C2', 'single_select', 'Do you have a malpractice or E&O policy in force right now?', {
    'C2-yes': 'Yes', 'C2-renewing': 'We are renewing it', 'C2-no': 'No', 'C2-unsure': 'Not sure' }),
  q('C3', 'single_select', 'Has the software ever given a client wrong information, or shared something it should not have?', {
    'C3-never': 'Never', 'C3-nearmiss': 'Once, caught before it caused a problem', 'C3-reached': 'Yes, it reached a client', 'C3-unsure': 'Not sure' }),
  q('F1', 'single_select', 'Counting everyone, not just lawyers, how many people work at the firm?', {
    'F1-1': 'Just me', 'F1-2-5': '2 to 5', 'F1-6-15': '6 to 15', 'F1-16-30': '16 to 30', 'F1-31-75': '31 to 75',
    'F1-76-150': '76 to 150', 'F1-150-plus': 'More than 150', 'F1-unsure': 'Not sure' }),
  q('F2', 'multi_select', 'Which of these are your main areas of work? Check all that apply.', {
    'F2-criminal': 'Criminal defense', 'F2-immigration': 'Immigration', 'F2-personal-injury': 'Personal injury',
    'F2-medical-malpractice': 'Medical malpractice', 'F2-family': 'Family', 'F2-litigation': 'Commercial or civil litigation',
    'F2-employment': 'Employment', 'F2-ip': 'Intellectual property or patents', 'F2-corporate': 'Corporate or M&A',
    'F2-real-estate': 'Real estate', 'F2-tax': 'Tax', 'F2-consumer': 'Consumer, including lemon law', 'F2-other': 'Something else' }),
  q('PS-1', 'single_select', 'We could not confirm all of your lawyers in the state Bar records. Is everyone practising at the firm currently licensed and in good standing?', {
    'PS1-all': 'Yes, all of them', 'PS1-all-staff': 'Yes, though some staff are paralegals without a license',
    'PS1-not-all': 'Not all of them', 'PS1-unsure': 'Not sure' }),
  q('P0-1', 'single_select', 'Are you planning to add any automated or AI tools in the next year?', {
    'P01-no-plans': 'No plans', 'P01-maybe': 'Maybe', 'P01-looking': 'We are looking at it', 'P01-rolling': 'Already decided, rolling out soon' }),
  q('P0-2', 'single_select', 'Where do you keep client information?', {
    'P02-own': 'Only in systems we control', 'P02-cloud-ok': 'In cloud services with a confidentiality agreement',
    'P02-cloud-unchecked': 'In cloud services, terms not checked', 'P02-unsure': 'Not sure' }),
  q('P1-1', 'single_select', 'Before the assistant answers a client, does a person check what it says?', {
    'P11-review-before': 'A person reviews it before it goes out', 'P11-review-after': 'It answers on its own, a person checks afterward',
    'P11-no-check': 'It answers on its own and no one checks', 'P11-unsure': 'Not sure' }),
  q('P1-2', 'single_select', 'Could the assistant ever show one client something about a different client’s case?', {
    'P12-isolated': 'No, each client only sees their own', 'P12-untested': 'No, but we have never tested it',
    'P12-could': 'It could, we are not sure', 'P12-unsure': 'Not sure' }),
  q('P1-3', 'single_select', 'Do clients know they are talking to an automated assistant, and can they reach a person?', {
    'P13-both': 'Yes to both', 'P13-partial': 'They can reach a person but we do not say it is automated',
    'P13-neither': 'Neither', 'P13-unsure': 'Not sure' }),
  q('P1-4', 'single_select', 'Has anyone checked that the assistant answers every client the same way, without treating anyone differently?', {
    'P14-reviewed': 'Yes, we reviewed it for that', 'P14-reads': 'No, but we read the conversations regularly', 'P14-not': 'No', 'P14-unsure': 'Not sure' }),
  q('P2-1', 'single_select', 'When the software drafts or summarizes something, does a person read it before it goes out?', {
    'P21-always': 'Always', 'P21-most': 'Most of the time', 'P21-important': 'Only on important matters', 'P21-no-rule': 'No set rule' }),
  q('P2-2', 'single_select', 'Do you know which parts of your case software run automatically?', {
    'P22-know': 'Yes', 'P22-sort-of': 'More or less', 'P22-no': 'No, we just use it', 'P22-unsure': 'Not sure' }),
  q('P2-3', 'single_select', 'Has anything the software produced ever gone out with a mistake in it?', {
    'P23-never': 'Never', 'P23-caught': 'Once or twice, caught in time', 'P23-yes': 'Yes', 'P23-unsure': 'Not sure' }),
  q('P3-1', 'single_select', 'When the software helps with legal work, does a lawyer review all of it before it goes out?', {
    'P31-always': 'Always, no exception', 'P31-most': 'Most of the time', 'P31-important': 'Only on important matters', 'P31-no-rule': 'No set rule' }),
  q('P3-2', 'single_select', 'Do you check the cases and facts it gives you against the original source?', {
    'P32-always': 'Always, it is a rule', 'P32-most': 'Most of the time', 'P32-time': 'Only when there is time', 'P32-trust': 'We trust the tool' }),
  // P3-3 has two variants; selection asks exactly one, from whether Layer 1 found a policy.
  q('P3-3a', 'single_select', slots => slots.firmName
    ? `We saw that ${slots.firmName} has written guidance on using these tools. Who makes sure the team follows it?`
    : 'We saw that your firm has written guidance on using these tools. Who makes sure the team follows it?', {
    'P33-owner': 'A specific person or committee', 'P33-partner': 'The partner on each matter', 'P33-none': 'No one in particular', 'P33-unsure': 'Not sure' }),
  q('P3-3b', 'single_select', 'Is there any written guidance for your team on using these tools, even something informal?', {
    'P33-owner': 'Yes, written and shared', 'P33-partner': 'Something informal, not written', 'P33-none': 'No', 'P33-unsure': 'Not sure' }),
  q('P3-4', 'single_select', 'How much does your team rely on these tools?', {
    'P34-rarely': 'Rarely, occasional things', 'P34-sometimes': 'Once in a while', 'P34-normal': 'A normal part of our day',
    'P34-almost-all': 'Almost everything goes through them' }),
  q('P4-1', 'single_select', 'Before anything goes to a court, does someone check that every case citation in it is real?', {
    'P41-every': 'Yes, every citation, every time', 'P41-partner': 'The partner reviews the filing', 'P41-spot': 'We spot check', 'P41-none': 'No set process' }),
  q('DG-1', 'single_select', 'What client information goes into these tools?', {
    'DG1-anon': 'Nothing identifiable, we take out names and details', 'DG1-agreement': 'Full details, only in tools with a confidentiality agreement',
    'DG1-unchecked': 'Full details, terms not checked', 'DG1-unsure': 'Not sure' }),
  q('E-criminal', 'single_select', 'In criminal work a wrong case citation can affect someone’s freedom. Does every filing get checked against the original source?', {
    'EC-always': 'Yes, always', 'EC-most': 'Most of the time', 'EC-none': 'No set process' }),
  q('E-immigration', 'single_select', 'Immigration rules change often. Do you check that what the software tells you is still current?', {
    'EI-official': 'Yes, against an official source', 'EI-sometimes': 'Sometimes', 'EI-trust': 'We trust the tool' }),
  q('E-litigation', 'single_select', 'Do you have a process so a made-up case citation can never reach a court?', {
    'EL-verified': 'Yes, every citation is verified', 'EL-partner': 'The partner reviews it', 'EL-none': 'No set process' }),
  q('E-ip', 'single_select', 'Do you check every technical and legal reference the software gives you?', {
    'EP-always': 'Yes, always', 'EP-most': 'Most of them', 'EP-none': 'No set process' }),
  q('E-medmal-pi', 'single_select', 'Do you use these tools to read medical records or work out damages?', {
    'EM-no': 'No', 'EM-expert': 'Yes, and an expert checks the result', 'EM-none': 'Yes, with no one checking' }),
  q('E-family', 'single_select', 'Family matters involve very sensitive information. Does that information go into these tools?', {
    'EF-never': 'No, never', 'EF-approved': 'Only into tools we approved as secure', 'EF-general': 'Yes, into general tools' }),
  q('E-other', 'text', slots => slots.primaryPracticeArea
    ? `In ${slots.primaryPracticeArea}, what is the biggest thing that could go wrong if the software made a mistake?`
    : 'In your main area of work, what is the biggest thing that could go wrong if the software made a mistake?', {}),
].map(question => [question.id, question])));

export const OPEN_ANSWER_MAX_LENGTH = 1000;
export function questionText(question: BankQuestion, slots: Slots): string {
  return typeof question.text === 'string' ? question.text : question.text(slots) ?? '';
}
