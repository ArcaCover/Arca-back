import { describe,it,expect } from 'vitest';
import { fixtureResult } from '../../contracts/tests/fixture.js';
import { DEMO_BANK, type Answers } from '@arca/questions';
import { questionPoints, scoreAssessment } from '../src/layer2.js';
const answers:Answers={
  'D1.1':{kind:'option',optionId:'written_shared'},'D1.2':{kind:'option',optionId:'yes'},
  'D2.1':{kind:'options',optionIds:['legal_enterprise','enterprise_general']},
  'D3.1':{kind:'scale',value:4},'D3.2':{kind:'option',optionId:'primary_sources'},
  'D4.1':{kind:'options',optionIds:['redaction','agreements']},'D5.1':{kind:'number',value:12},
  'D6.1':{kind:'option',optionId:'yes'},
};
const input={assessmentId:'as_fixture',layer1:fixtureResult(),bank:DEMO_BANK,answers,completedAt:'2026-10-13T03:00:00.000Z'};
describe('demo Layer2 deterministic scoring',()=>{
  it('scores fixed denominators with explicit noncommercial demo status',()=>{
    const result=scoreAssessment(input);
    expect(result.layer2Score).toBe(100);expect(result.compositeScore).toBe(94.6);
    expect(result.tier).toBe('FORTRESS');expect(result.decision).toBe('UNKNOWN');
    expect(result.commercialDecisionBlocked).toBe(true);expect(result.flags).toContain('DEMO_BANK_NOT_APPROVED');
    expect(result.domains.every(d=>d.status==='KNOWN')).toBe(true);
  });
  it('informational selection and conditional answers cannot change score',()=>{
    expect(scoreAssessment({...input,answers:{...answers,'D1.1a':{kind:'option',optionId:'never'},'D6.2':{kind:'option',optionId:'no'}}})).toEqual(scoreAssessment(input));
  });
  it('does not shrink denominator or invent points when a scored answer is missing',()=>{
    const partial={...answers};delete partial['D1.1'];
    const result=scoreAssessment({...input,answers:partial});
    expect(result.domains[0]!.score).toBe(50);expect(result.domains[0]!.status).toBe('PARTIAL');
    expect(result.flags).toContain('INCOMPLETE_SCORED_COVERAGE');
  });
  it('preserves disciplinary restrictions despite perfect answers',()=>{
    const layer1=fixtureResult();layer1.preScore.overrides=[{id:'recent_sanction',decision:'REFERRAL_SENIOR',reason:'Observed recent sanction'}];
    layer1.preScore.flags=['KNOWN_SANCTION'];
    const result=scoreAssessment({...input,layer1});expect(result.decision).toBe('REFERRAL_SENIOR');expect(result.flags).toContain('KNOWN_SANCTION');
    layer1.preScore.overrides.push({id:'disbarred',decision:'DECLINE',reason:'Observed disbarment'});
    expect(scoreAssessment({...input,layer1}).decision).toBe('DECLINE');
  });
  it('keeps insufficient evidence blocked and missing Layer1 score unknown',()=>{
    const layer1=fixtureResult();layer1.preScore.assessmentStatus='INSUFFICIENT_EVIDENCE';layer1.preScore.total=null;
    const result=scoreAssessment({...input,layer1});expect(result.compositeScore).toBeNull();expect(result.tier).toBe('UNKNOWN');expect(result.decision).toBe('UNKNOWN');expect(result.flags).toContain('INSUFFICIENT_EVIDENCE');
  });
  it('records contradictory declarations instead of rewriting them',()=>{
    const result=scoreAssessment({...input,answers:{...answers,'D2.1':{kind:'options',optionIds:['none']}}});
    expect(result.flags).toContain('ANSWER_CONTRADICTS_WEBSITE');expect(result.domains.find(d=>d.key==='tools')!.score).toBe(0);
  });
  it('clamps negative domain points and reports oversight flags',()=>{
    const result=scoreAssessment({...input,answers:{...answers,'D2.1':{kind:'options',optionIds:['consumer']},'D3.1':{kind:'scale',value:0}}});
    expect(result.domains.find(d=>d.key==='tools')!.score).toBe(0);expect(result.flags).toContain('NO_HUMAN_REVIEW');expect(result.flags).toContain('CONSUMER_AI_IN_CLIENT_WORK');
  });
  it.each([[0,0],[1,4],[2,4],[3,8],[8,8],[9,10],[80,10]])('uses deterministic number bands (%s)',(value,points)=>{
    expect(questionPoints(DEMO_BANK.questions.find(q=>q.id==='D5.1')!,{kind:'number',value})).toBe(points);
  });
  it('computes bounded independent marginal improvements, not premium promises',()=>{
    const result=scoreAssessment({...input,answers:{...answers,'D1.1':{kind:'option',optionId:'none'}}});
    const action=result.actionPlan.find(a=>a.id==='improve:D1.1')!;
    expect(action.pointsGain).toBe(1.75);expect(action.detail).toContain('independent');
    expect(result.actionPlan.every(a=>a.pointsGain>0)).toBe(true);
  });
  it('is stable for the same versioned snapshot',()=>expect(scoreAssessment(structuredClone(input))).toEqual(scoreAssessment(input)));
});
