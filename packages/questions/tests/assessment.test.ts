import { describe,it,expect,vi } from 'vitest';
import { fixtureResult } from '../../contracts/tests/fixture.js';
import { DEMO_BANK, QuestionBank, collectEvidence, createOpenAIPlanner, evaluateCondition, planAssessment,
  reconcileAnswers, renderQuestions, rulesPlan, validateAnswer, validatePlan, visibleQuestions } from '../src/index.js';

const layer1=fixtureResult();
const evidence=collectEvidence(layer1);
const input={bank:DEMO_BANK,layer1,evidence};
const rules=rulesPlan(DEMO_BANK,layer1,evidence);
const q=(id:string)=>DEMO_BANK.questions.find(q=>q.id===id)!;

describe('fixed versioned demo bank',()=>{
  it('has complete comparable scored coverage and is explicitly unapproved',()=>{
    expect(QuestionBank.parse(DEMO_BANK).bankStatus).toBe('DEMO');
    expect(DEMO_BANK.questions.filter(q=>q.scored)).toHaveLength(8);
    expect(DEMO_BANK.domains.reduce((n,d)=>n+d.weight,0)).toBe(100);
  });
  it.each([
    (bank:typeof DEMO_BANK)=>bank.questions.push(bank.questions[0]!),
    (bank:typeof DEMO_BANK)=>{bank.domains[0]!.weight=30;},
    (bank:typeof DEMO_BANK)=>{bank.questions[0]!.showWhen={answer:'D1.2',op:'eq',value:'yes'};},
    (bank:typeof DEMO_BANK)=>{bank.questions[8]!.showWhen={answer:'D1.1a',op:'eq',value:'yearly'};},
    (bank:typeof DEMO_BANK)=>{bank.questions[8]!.options![0]!.points=5;},
    (bank:typeof DEMO_BANK)=>{bank.questions[3]!.scale!.points=[0,10];},
    (bank:typeof DEMO_BANK)=>{bank.questions[6]!.number!.bands[1]!.upTo=0;},
  ])('rejects malformed banks',mutate=>{const bank=structuredClone(DEMO_BANK);mutate(bank);expect(QuestionBank.safeParse(bank).success).toBe(false);});
});
describe('answers and deterministic follow-ups',()=>{
  it('retains latent follow-ups and activates them when answers arrive',()=>{
    expect(rules.items.some(i=>i.questionId==='D1.1a')).toBe(true);
    expect(visibleQuestions(DEMO_BANK,rules,layer1,{}).some(q=>q.id==='D1.1a')).toBe(false);
    expect(visibleQuestions(DEMO_BANK,rules,layer1,{'D1.1':{kind:'option',optionId:'written_shared'}}).some(q=>q.id==='D1.1a')).toBe(true);
  });
  it('drops hidden answers instead of silently reviving them later',()=>{
    const answers=reconcileAnswers(DEMO_BANK,rules,layer1,{'D1.1':{kind:'option',optionId:'none'},'D1.1a':{kind:'option',optionId:'yearly'}});
    expect(answers['D1.1a']).toBeUndefined();
    expect(visibleQuestions(DEMO_BANK,rules,layer1,{...answers,'D1.1':{kind:'option',optionId:'written_shared'}}).some(q=>q.id==='D1.1a')).toBe(true);
  });
  it('unknown is never treated as a negative answer, including inside NOT',()=>{
    expect(evaluateCondition({not:{answer:'D1.1',op:'eq',value:'none'}},layer1,{})).toBe(false);
    expect(evaluateCondition({answer:'D1.1',op:'neq',value:'none'},layer1,{})).toBe(false);
    expect(evaluateCondition({answer:'D2.1',op:'excludes',value:'none'},layer1,{})).toBe(false);
  });
  it.each([
    ['D1.1',{kind:'option',optionId:'invented'}],['D1.1',{kind:'options',optionIds:['none']}],
    ['D2.1',{kind:'options',optionIds:[]}],['D2.1',{kind:'options',optionIds:['consumer','consumer']}],
    ['D2.1',{kind:'options',optionIds:['none','consumer']}],['D3.1',{kind:'scale',value:1.5}],
    ['D3.1',{kind:'scale',value:5}],['D5.1',{kind:'number',value:Infinity}],['D5.1',{kind:'number',value:-1}],
    ['D5.1',{kind:'number',value:2.5}],['D5.1',{kind:'number',value:81}],
  ])('rejects invalid %s answer', (id,answer)=>expect(validateAnswer(q(id as string),answer)).toBe(false));
  it('supports all five answer types including numeric zero',()=>{
    expect(validateAnswer(q('D1.1'),{kind:'option',optionId:'none'})).toBe(true);
    expect(validateAnswer(q('D1.2'),{kind:'option',optionId:'yes'})).toBe(true);
    expect(validateAnswer(q('D2.1'),{kind:'options',optionIds:['legal_enterprise','consumer']})).toBe(true);
    expect(validateAnswer(q('D3.1'),{kind:'scale',value:0})).toBe(true);
    expect(validateAnswer(q('D5.1'),{kind:'number',value:0})).toBe(true);
  });
  it('exposes no points and never credits internal sharing from a website',()=>{
    const rendered=renderQuestions(DEMO_BANK,rules,layer1,{},evidence);
    expect(JSON.stringify(rendered)).not.toContain('points');
    expect(rendered[0]!.suggestedAnswer).toEqual({kind:'option',optionId:'public_only'});
    expect(rendered[0]!.evidence[0]!.sourceUrl).toBeNull();
    expect(rendered[0]!.context).toContain('confirmation');
  });
});
describe('guarded planner and rules fallback',()=>{
  it('is deterministic without an agent and preserves evidence IDs',async()=>{
    const a=await planAssessment(input);const b=await planAssessment(input);
    expect(a).toEqual(b);expect(a.planner).toBe('rules');
    expect(collectEvidence(structuredClone(layer1))).toEqual(evidence);
  });
  it('accepts valid selected informational questions and exact grounded context',async()=>{
    const proposed=structuredClone(rules); proposed.items=proposed.items.filter(i=>!['D3.3','D4.2'].includes(i.questionId));
    proposed.items.push({questionId:'D6.2',context:null,evidenceIds:[],suggestedOption:null});
    const result=await planAssessment({...input,agent:{model:'fixture',plan:async()=>proposed}});
    expect(result.planner).toBe('agent');expect(result.plan.items.some(i=>i.questionId==='D6.2')).toBe(true);
  });
  it('retries once and falls back when required coverage, follow-ups or IDs are wrong',async()=>{
    const plan=vi.fn(async()=>({intro:'Hello',items:rules.items.filter(i=>i.questionId!=='D1.1a')}));
    const result=await planAssessment({...input,agent:{model:'fixture',plan}});
    expect(plan).toHaveBeenCalledTimes(2);expect(result.planner).toBe('rules');
    expect(()=>validatePlan({...rules,items:[...rules.items.slice(1),rules.items[1]!]},input)).toThrow();
    expect(()=>validatePlan({...rules,items:[...rules.items.slice(1),{questionId:'D9.1',context:null,evidenceIds:[],suggestedOption:null}]},input)).toThrow();
  });
  it('strips unsupported context, unsupported suggestions and untrusted intro',()=>{
    const proposed=structuredClone(rules);proposed.intro='You are guaranteed coverage for $100';
    proposed.items[0]={...proposed.items[0]!,context:'Your policy is shared with everyone.',suggestedOption:'written_shared'};
    const parsed=validatePlan(proposed,input);
    expect(parsed.intro).not.toContain('guaranteed');expect(parsed.items[0]!.context).toBeNull();
    expect(parsed.items[0]!.suggestedOption).toBeNull();expect(parsed.items[0]!.evidenceIds).toEqual([]);
  });
  it('times out a stalled provider and still creates a usable plan',async()=>{
    let aborted=false;
    const result=await planAssessment({...input,timeoutMs:5,agent:{model:'fixture',plan:async(_input,signal)=>{
      signal.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});
    }}});
    expect(aborted).toBe(true);expect(result.planner).toBe('rules');
  });
  it('uses structured output through injected transport without sending personal identity',async()=>{
    const transport=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify(rules)}}]})) as unknown as typeof fetch;
    const agent=createOpenAIPlanner({apiKey:'fixture-only',model:'fixture-model',transport});
    await agent.plan(input,new AbortController().signal);
    const body=JSON.parse(String(vi.mocked(transport).mock.calls[0]![1]!.body));
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(JSON.stringify(body)).not.toContain(layer1.email);expect(JSON.stringify(body)).not.toContain('Jane Smith');
  });
});
