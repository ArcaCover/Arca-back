import { QuestionBank, type Question } from './schema.js';

// Engineering fixtures only. Juan José owns the eventual underwriting questions and weights.
const base = { help: null, scored: true, mandatory: true, maxPoints: 10, priority: 1, relevantSignals: [] as Question['relevantSignals'] } as const;
const yesNo = [{id:'yes',label:'Yes',points:10},{id:'no',label:'Not yet',points:0}];
const info = { ...base, scored:false, mandatory:false, maxPoints:0, priority:3 } as const;
const questions: Question[] = [
  {...base,id:'D1.1',domain:'governance',type:'single_select',text:'How is your firm’s AI policy shared with the team?',help:'A policy on a public website does not establish whether your team has received internal guidance.',
    relevantSignals:['website.W1_aiPolicy.found'],options:[
      {id:'written_shared',label:'Written and shared with everyone',points:10},
      {id:'written_partial',label:'Written, but not everyone has seen it',points:6},
      {id:'public_only',label:'Published publicly; internal guidance is not confirmed',points:3},
      {id:'informal',label:'We have informal guidance',points:2},
      {id:'none',label:'No policy yet',points:0,flag:'NO_AI_POLICY'}],
    prefillFrom:[{when:{signal:'website.W1_aiPolicy.found',op:'eq',value:true},option:'public_only',evidenceSignal:'website.W1_aiPolicy.found'}]},
  {...base,id:'D1.2',domain:'governance',type:'yes_no',text:'Is someone responsible for overseeing AI use at your firm?',options:yesNo},
  {...base,id:'D2.1',domain:'tools',type:'multi_select',text:'Which AI accounts are used for client work?',help:'Select all that apply. “None” cannot be combined with other choices.',relevantSignals:['website.W2_aiInServices.found'],options:[
    {id:'legal_enterprise',label:'Legal AI platforms with a business agreement',points:6},
    {id:'enterprise_general',label:'General-purpose enterprise AI accounts',points:4},
    {id:'consumer',label:'Free or personal AI accounts',points:-4,flag:'CONSUMER_AI_IN_CLIENT_WORK'},
    {id:'none',label:'None',points:0,exclusive:true}],
    contradicts:[{option:'none',when:{signal:'website.W2_aiInServices.found',op:'eq',value:true},flag:'ANSWER_CONTRADICTS_WEBSITE'}]},
  {...base,id:'D3.1',domain:'oversight',type:'scale',text:'How much AI-assisted work is reviewed by a lawyer before it reaches a client?',scale:{min:0,max:4,step:1,minLabel:'None',maxLabel:'All of it',points:[0,2,5,8,10]}},
  {...base,id:'D3.2',domain:'oversight',type:'single_select',text:'How are AI-generated legal citations checked?',options:[
    {id:'primary_sources',label:'Every citation is checked against the primary source',points:10},
    {id:'sample',label:'We check a sample of citations',points:4},
    {id:'none',label:'We do not have a consistent check',points:0,flag:'NO_CITATION_REVIEW'}]},
  {...base,id:'D4.1',domain:'data_protection',type:'multi_select',text:'Which safeguards protect client information in AI tools?',options:[
    {id:'redaction',label:'Client identifiers are removed before use',points:5},
    {id:'agreements',label:'Approved data protection agreements and settings',points:5},
    {id:'none',label:'No consistent safeguards yet',points:0,exclusive:true,flag:'NO_DATA_SAFEGUARDS'}]},
  {...base,id:'D5.1',domain:'training',type:'number',text:'How many hours of AI training does each lawyer receive per year?',help:'Use the typical number for your team. Enter 0 if there is no training yet.',number:{min:0,max:80,unit:'hours per lawyer / year',bands:[{upTo:0,points:0},{upTo:2,points:4},{upTo:8,points:8},{upTo:80,points:10}]}},
  {...base,id:'D6.1',domain:'incident_preparedness',type:'yes_no',text:'Do you have a documented response plan for an AI-related mistake?',options:yesNo},
  {...info,id:'D1.1a',domain:'governance',type:'single_select',text:'How often is your written AI policy reviewed?',help:'This follow-up adds context and does not change the demo score.',showWhen:{any:[{answer:'D1.1',op:'eq',value:'written_shared'},{answer:'D1.1',op:'eq',value:'written_partial'},{answer:'D1.1',op:'eq',value:'public_only'}]},options:[{id:'quarterly',label:'Quarterly or more often',points:0},{id:'yearly',label:'Once a year',points:0},{id:'never',label:'It has not been reviewed yet',points:0}]},
  {...info,id:'D2.1a',domain:'tools',type:'yes_no',text:'Is there a plan to move client work away from personal AI accounts?',help:'This follow-up adds context and does not change the demo score.',showWhen:{answer:'D2.1',op:'includes',value:'consumer'},options:[{id:'yes',label:'Yes, a transition is planned',points:0},{id:'no',label:'Not yet',points:0}]},
  {...info,id:'D4.2',domain:'data_protection',type:'yes_no',text:'Do you review AI vendors’ data retention settings?',relevantSignals:['website.W6_privacyPolicy.found'],options:[{id:'yes',label:'Yes',points:0},{id:'no',label:'Not yet',points:0}]},
  {...info,id:'D5.2',domain:'training',type:'yes_no',text:'Does AI training include examples of inaccurate outputs?',options:[{id:'yes',label:'Yes',points:0},{id:'no',label:'Not yet',points:0}]},
  {...info,id:'D3.3',domain:'oversight',type:'yes_no',text:'Do you tell clients when AI assists with their work?',relevantSignals:['website.W3_aiDisclosure.found'],options:[{id:'yes',label:'Yes',points:0},{id:'no',label:'Not consistently',points:0}]},
  {...info,id:'D6.2',domain:'incident_preparedness',type:'yes_no',text:'Does your team know where to report an AI-related concern?',options:[{id:'yes',label:'Yes',points:0},{id:'no',label:'Not yet',points:0}]},
];
export const DEMO_BANK: QuestionBank = QuestionBank.parse({bankVersion:'0.1.0-demo.1',bankStatus:'DEMO',
  domains:[{key:'governance',label:'AI Governance & Policy',weight:25,minQuestions:2},
    {key:'tools',label:'AI Tool Environment',weight:20,minQuestions:1},
    {key:'oversight',label:'Human Oversight & Review',weight:20,minQuestions:2},
    {key:'data_protection',label:'Data Protection & Confidentiality',weight:15,minQuestions:1},
    {key:'training',label:'Training & Competency',weight:10,minQuestions:1},
    {key:'incident_preparedness',label:'Incident Preparedness',weight:10,minQuestions:1}],
  questions,limits:{minQuestions:8,maxQuestions:12}});
