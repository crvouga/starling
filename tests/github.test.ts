import {createRuntime,prepareFixtures} from '@crvouga/mockingbird-service-github';
import {Octokit} from '@octokit/rest';
import {expect,it} from 'vitest';
import {branchAndPull,authorized} from '../src/worker/github';
import type {Tree,Project} from '../src/shared';
import {sign,verify} from '@octokit/webhooks-methods';
it('recovers a previously created branch and draft PR using the Mockingbird commit graph',async()=>{
 const rt=createRuntime({seed:42}),base='a'.repeat(40),head='b'.repeat(40),owner='aviary',repo='field-notes';
 const r=await rt.fetch(new Request('http://mock/__admin/github/repositories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner,name:repo,commits:[{sha:base,parents:[]},{sha:head,parents:[base]}],branches:{main:base,'starling/change':head}})}));expect(r.status).toBe(201);
 const api=new Octokit({request:{fetch:(url:string,init:RequestInit)=>rt.fetch(new Request(url,init))},log:{error(){},warn(){},info(){},debug(){}}}),p:Project={id:1,name:owner+'/'+repo,installation:17,base:'main'},t={branch:'starling/change',title:'Change',base:'main'} as Tree;
 const n=await branchAndPull(api,p,t);expect(await branchAndPull(api,p,t)).toBe(n);const {data}=await api.rest.pulls.get({owner,repo,pull_number:n});expect(data.draft).toBe(true);await expect(authorized(api,p,true)).rejects.toThrow();expect((await api.rest.pulls.list({owner,repo})).data).toHaveLength(1)
});
it('verifies signed webhook bytes and rejects tampering',async()=>{const sig=await sign('fixture-secret','{"action":"closed"}');expect(await verify('fixture-secret','{"action":"closed"}',sig)).toBe(true);expect(await verify('fixture-secret','{"action":"opened"}',sig)).toBe(false)});
