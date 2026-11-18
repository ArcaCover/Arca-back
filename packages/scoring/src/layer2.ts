import { AssessmentResult, type AnswerValue, type Layer1Result } from '@arca/contracts';
import { evaluateCondition, validateAnswer, type Answers, type Question, type QuestionBank } from '@arca/questions';
import { restrictDecision, tierForScore } from './math.js';
import { LAYER1_UNAVAILABLE, WEBSITE_UNAVAILABLE } from './website-outcome.js';

export const LAYER2_SCORING_VERSION = 'layer2-demo-fixed-coverage-0.1.0';
// Demonstration only; the product owner has not approved the composite weighting.
export const DEMO_LAYER1_WEIGHT = 0.3;
export const DEMO_LAYER2_WEIGHT = 0.7;
const round = (value:number) => Math.round(value*100)/100;
const clamp = (value:number,max:number) => Math.max(0,Math.min(max,value));
export function questionPoints(question:Question, answer:AnswerValue | undefined): number {
  if (!answer || !validateAnswer(question,answer)) return 0;
  if (answer.kind === 'option') return Math.min(question.maxPoints,question.options!.find(o=>o.id===answer.optionId)!.points);
  if (answer.kind === 'options') return Math.min(question.maxPoints,answer.optionIds.reduce((sum,id)=>sum+question.options!.find(o=>o.id===id)!.points,0));
  if (answer.kind === 'scale') return Math.min(question.maxPoints,question.scale!.points[Math.round((answer.value-question.scale!.min)/question.scale!.step)]!);
  return Math.min(question.maxPoints,question.number!.bands.find(b=>answer.value<=b.upTo)!.points);
}
function domainResults(bank:QuestionBank,answers:Answers): AssessmentResult['domains'] {
  return bank.domains.map(domain=>{
    const fixed = bank.questions.filter(q=>q.scored&&q.domain===domain.key);
    const maximum = fixed.reduce((sum,q)=>sum+q.maxPoints,0);
    return {key:domain.key,label:domain.label,weight:domain.weight,
      score:round(maximum ? clamp(fixed.reduce((sum,q)=>sum+questionPoints(q,answers[q.id]),0),maximum)/maximum*100 : 0),
      status:fixed.length >= domain.minQuestions && fixed.every(q=>validateAnswer(q,answers[q.id])) ? 'KNOWN' : 'PARTIAL'};
  });
}
/**
 * A count and its unit as a sentence reads them. The bank names a unit in the plural ('hours per lawyer / year'), so
 * one of it drops the plural ending of the unit's first word: '1 hour per lawyer / year'.
 */
export function numberLabel(value:number,unit:string): string {
  return `${value} ${value===1 ? unit.replace(/^([A-Za-z]*[A-Za-rt-z])s(?![A-Za-z])/,'$1') : unit}`;
}
function betterAnswers(q:Question,answer:AnswerValue): Array<{answer:AnswerValue;label:string}> {
  if (q.options && answer.kind==='option') return q.options.map(o=>({answer:{kind:'option' as const,optionId:o.id},label:o.label}));
  if (q.options && answer.kind==='options') {
    const candidates = q.options.flatMap(o=>{
      const ids = answer.optionIds.includes(o.id) ? answer.optionIds.filter(id=>id!==o.id) : o.exclusive ? [o.id] : [...answer.optionIds.filter(id=>!q.options!.find(x=>x.id===id)!.exclusive),o.id];
      return ids.length ? [{answer:{kind:'options' as const,optionIds:ids},label:ids.map(id=>q.options!.find(x=>x.id===id)!.label).join('; ')}] : [];
    });
    return candidates.filter(c=>validateAnswer(q,c.answer));
  }
  if (q.scale) return q.scale.points.map((_,i)=>({answer:{kind:'scale' as const,value:q.scale!.min+i*q.scale!.step},label:`Review level ${q.scale!.min+i*q.scale!.step} of ${q.scale!.max}`}));
  if (q.number) return q.number.bands.map((_,i)=>{
    const value=i===0?q.number!.min:q.number!.bands[i-1]!.upTo+1;
    return {answer:{kind:'number' as const,value},label:numberLabel(value,q.number!.unit)};
  });
  return [];
}
export function scoreAssessment({assessmentId,layer1,bank,answers,completedAt}: {
  assessmentId:string;layer1:Layer1Result;bank:QuestionBank;answers:Answers;completedAt:string;
}): AssessmentResult {
  const domains=domainResults(bank,answers);
  const layer2Score=round(domains.reduce((sum,d)=>sum+d.score*d.weight/100,0));
  // With the firm website unread, Layer 1 has no public evidence: a 0 there would only drag the composite down, so the
  // composite is the answers alone, marked low confidence by the flags (DN-12 §14).
  const answersOnly=layer1.preScore.flags.includes(WEBSITE_UNAVAILABLE);
  const layer2Weight=answersOnly?1:DEMO_LAYER2_WEIGHT;
  const layer1Score=answersOnly?null:layer1.preScore.total;
  const compositeScore=answersOnly?layer2Score:layer1Score===null?null:round(layer1Score*DEMO_LAYER1_WEIGHT+layer2Score*DEMO_LAYER2_WEIGHT);
  const flags=new Set([...layer1.preScore.flags,'DEMO_BANK_NOT_APPROVED','DEMO_COMPOSITE_FORMULA','COMMERCIAL_DECISION_BLOCKED']);
  if (answersOnly) flags.add(LAYER1_UNAVAILABLE);
  if (domains.some(d=>d.status==='PARTIAL')) flags.add('INCOMPLETE_SCORED_COVERAGE');
  if (layer1.preScore.assessmentStatus==='INSUFFICIENT_EVIDENCE') flags.add('INSUFFICIENT_EVIDENCE');
  for(const q of bank.questions) {
    const answer=answers[q.id];
    if (!answer || !validateAnswer(q,answer)) continue;
    const selected=answer.kind==='option'?[answer.optionId]:answer.kind==='options'?answer.optionIds:[];
    q.options?.filter(o=>selected.includes(o.id)&&o.flag).forEach(o=>flags.add(o.flag!));
    q.contradicts?.filter(rule=>selected.includes(rule.option)&&evaluateCondition(rule.when,layer1,answers)).forEach(rule=>flags.add(rule.flag));
    if(q.id==='D3.1'&&answer.kind==='scale'&&answer.value===0) flags.add('NO_HUMAN_REVIEW');
  }
  const actionPlan:AssessmentResult['actionPlan']=[];
  for(const q of bank.questions.filter(q=>q.scored)) {
    const answer=answers[q.id];
    if(!answer||!validateAnswer(q,answer)) continue;
    const current=domains.find(d=>d.key===q.domain)!;
    const candidates=betterAnswers(q,answer).map(candidate=>{
      const projected=domainResults(bank,{...answers,[q.id]:candidate.answer}).find(d=>d.key===q.domain)!;
      return {...candidate,gain:round((projected.score-current.score)*current.weight/100*layer2Weight)};
    }).filter(c=>c.gain>0).sort((a,b)=>a.gain-b.gain||a.label.localeCompare(b.label));
    const next=candidates[0];
    // Only the step itself. The screen and the report say once that the gains are provisional estimates, each on its own.
    if(next) actionPlan.push({id:`improve:${q.id}`,domain:q.domain,title:q.text,detail:`Next step: ${next.label}.`,pointsGain:next.gain});
  }
  actionPlan.sort((a,b)=>b.pointsGain-a.pointsGain||a.id.localeCompare(b.id));
  // A questionnaire cannot erase a known disciplinary restriction or fill missing public
  // evidence. Fixture results never emit AUTO_BIND, even with a perfect demonstration score.
  const restrictions=layer1.preScore.overrides.filter(o=>['REFERRAL','REFERRAL_SENIOR','DECLINE'].includes(o.decision));
  const decision=restrictDecision('UNKNOWN',restrictions);
  return AssessmentResult.parse({assessmentId,scanId:layer1.scanId,bankVersion:bank.bankVersion,bankStatus:'DEMO',
    scoringVersion:LAYER2_SCORING_VERSION,commercialDecisionBlocked:true,layer1Score,layer2Score,
    compositeScore,tier:tierForScore(compositeScore),decision,domains,flags:[...flags].sort(),actionPlan,completedAt});
}
