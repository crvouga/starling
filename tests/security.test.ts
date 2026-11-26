import {describe,expect,it} from 'vitest';
import fc from 'fast-check';
import {open,seal,random,digest,type Env} from '../src/worker/core';
import {decodeNative,nativeCommand,safePush,scrub} from '../src/worker/native';
import {scriptName} from '../src/shared';
const branch='starling/fixture-01234567',id='652ff0c8-8cbe-45d6-b3bf-de754a3733fa';
function update(ref:string,more='0000',sha='f'.repeat(40)){const line='a'.repeat(40)+' '+sha+' refs/heads/'+ref+'\0report-status\n';return new TextEncoder().encode((Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line+more)}
describe('Branch-scoped Git transport',()=>{
 it('accepts a single non-deleting update only on the assigned ref',()=>{expect(safePush(update(branch),branch)).toBe(true);expect(safePush(update(branch,'0000','0'.repeat(40)),branch)).toBe(false);expect(safePush(update(branch,'0040more commands'),branch)).toBe(false);fc.assert(fc.property(fc.string().filter(s=>s!==branch),s=>!safePush(update(s),branch)))});
 it('rejects arbitrary or truncated requests',()=>{fc.assert(fc.property(fc.uint8Array({maxLength:85}),packet=>!safePush(packet,branch)))});
});
it('binds credentials to a tenant and a provider and randomizes each encryption',async()=>{const env={KEY:random()} as Env,box=await seal(env,'1:claude','private');expect(await open(env,'1:claude',box)).toBe('private');await expect(open(env,'2:claude',box)).rejects.toThrow();await expect(open(env,'1:codex',box)).rejects.toThrow();expect(await seal(env,'1:claude','private')).not.toBe(box);expect(await digest('opaque')).toHaveLength(43)});
it('preserves native IDs, file changes and distinct assistant messages',()=>{expect(decodeNative(JSON.stringify({type:'thread.started',thread_id:id})).native).toBe(id);expect(decodeNative(JSON.stringify({type:'item.completed',item:{type:'file_change',changes:[{path:'README.md'}]}})).updates[0].body).toContain('README.md');expect(decodeNative(JSON.stringify({type:'assistant',session_id:id,message:{content:[{type:'text',text:'Finished'}]}}))).toEqual({native:id,updates:[{kind:'assistant',body:'Finished'}],failed:undefined});for(const p of ['claude','codex'] as const){const cmd=nativeCommand(p,id,id,'a; echo b');expect(cmd).toContain(id);expect(cmd.join(' ')).toContain('resume');expect(cmd.at(-1)).toContain('a; echo b')}});
it('rejects command injection in script names and redacts recognized keys',()=>{expect(scriptName.safeParse('test; rm -r .').success).toBe(false);expect(scrub('token sk-'+ 'a'.repeat(30))).toBe('token [redacted]')});
