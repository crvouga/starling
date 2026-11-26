import {z} from 'zod';
import type {Provider} from '../shared';
export const instructions='Work on the checked-out pull request branch. Implement the request and check the observable result. Use repository scripts and deterministic Mockingbird fixtures. Use fake development credentials. Commit meaningful increments. Starling pushes this branch, runs checks and publishes your final report. Include design decisions, check results and limitations. For visual changes put screenshots or a short WebM in .starling/evidence/. Never include credentials. Do not merge or change other branches.';
export function nativeCommand(p:Provider,id:string|null,session:string,input:string,image?:string){
  if(p==='claude')return ['claude','-p','--model','claude-sonnet-4-6','--input-format','stream-json','--output-format','stream-json','--include-partial-messages','--permission-prompt-tool','stdio','--verbose','--permission-mode','acceptEdits','--allowedTools','Read,Edit,Write,Glob,Grep','--append-system-prompt',instructions,...(id?['--resume',id]:['--session-id',session])];
  return ['codex','exec',...(id?['resume']:[]),'--json','--dangerously-bypass-approvals-and-sandbox','-c','model_provider="starling"','-c','model_providers.starling={name="CLIProxyAPI",base_url="https://model.starling.internal/v1",wire_api="responses"}','-c','features.plugins=false','-c','analytics.enabled=false','-c','check_for_update_on_startup=false','-m','gpt-5.4',...(image?['-i',image]:[]),'--',...(id?[id]:[]),instructions+'\n\n'+input]
}
const block=z.object({type:z.string(),text:z.string().optional(),name:z.string().optional(),input:z.unknown().optional()});
const envelope=z.object({type:z.string(),thread_id:z.uuid().optional(),session_id:z.uuid().optional(),item:z.object({type:z.string(),text:z.string().optional(),command:z.string().optional(),aggregated_output:z.string().optional(),changes:z.unknown().optional()}).optional(),message:z.unknown().optional(),result:z.string().optional(),is_error:z.boolean().optional()});
export type NativeUpdate={kind:'assistant'|'tool'|'status';body:string};
export function decodeNative(line:string):{native?:string;updates:NativeUpdate[];failed?:boolean}{
  let json:unknown;try{json=JSON.parse(line)}catch{return {updates:[]}}
  const parsed=envelope.safeParse(json);if(!parsed.success)return {updates:[]};const e=parsed.data,updates:NativeUpdate[]=[];
  if(e.type==='assistant'){const m=z.object({content:z.array(block)}).safeParse(e.message);if(m.success)for(const b of m.data.content){if(b.type==='text'&&b.text)updates.push({kind:'assistant',body:b.text});if(b.type==='tool_use')updates.push({kind:'tool',body:b.name+' '+JSON.stringify(b.input??{})})}}
  if(e.type==='item.completed' && e.item){const i=e.item;if(i.type==='agent_message'&&i.text)updates.push({kind:'assistant',body:i.text});else if(i.type!=='reasoning')updates.push({kind:'tool',body:[i.command??i.type,i.aggregated_output, i.changes?JSON.stringify(i.changes):''].filter(Boolean).join('\n')})}
  if(e.type==='turn.failed'||e.type==='error'||e.is_error)updates.push({kind:'status',body:e.result??(typeof e.message==='string'?e.message:'The provider reported an error.')});
  return {native:e.thread_id??e.session_id,updates,failed:e.type==='turn.failed'||e.is_error}
}
export function safePush(packet:Uint8Array,branch:string){
  // Smart HTTP v0 receive-pack: accept exactly one update followed by flush and pack data.
  const prefix=new TextDecoder().decode(packet.slice(0,4));if(!/^[0-9a-f]{4}$/.test(prefix))return false;
  const end=parseInt(prefix,16);if(end<90||end>1024||packet.length<end+4)return false;
  const line=new TextDecoder().decode(packet.slice(4,end)).replace(/\n$/,'');
  const [cmd,caps='']=line.split('\0');
  const [old,next,ref,...extra]=cmd.split(' ');
  return extra.length===0 && /^[a-f0-9]{40}$/.test(old) && !/^0+$/.test(old) && /^[a-f0-9]{40}$/.test(next) && !/^0+$/.test(next) && ref==='refs/heads/'+branch && !/[\r\n]/.test(line) && !caps.includes('push-options') && new TextDecoder().decode(packet.slice(end,end+4))==='0000'
}
export function scrub(value:string){return value.replace(/(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[\w]{20,}|sk-[\w-]{16,}|-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$))/g,'[redacted]').slice(0,24000)}
