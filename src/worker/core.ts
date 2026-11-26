import type {Workspace} from './sandbox';
import type {ProviderProxy} from './outbound';
import {HTTPException} from 'hono/http-exception';
export interface Env {LOCAL_GITHUB?:string;DB:D1Database;PRIVATE:R2Bucket;ASSETS:Fetcher;WORKTREES:DurableObjectNamespace<Workspace>;PROXIES:DurableObjectNamespace<ProviderProxy>;ORIGIN:string;KEY:string;GH_APP_ID:string;GH_SLUG:string;GH_CLIENT_ID:string;GH_CLIENT_SECRET:string;GH_PRIVATE_KEY:string;GH_WEBHOOK_SECRET:string}
export type User={id:number;login:string;credential:string;expires:number};
export function fail(status:400|401|403|404|409|413|429|502|503,message:string):never {throw new HTTPException(status,{message})}
export function base64url(data:ArrayBuffer|Uint8Array){return btoa(String.fromCharCode(...new Uint8Array(data as ArrayBuffer))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
export function bytes(s:string){return Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))}
export async function digest(s:string){return base64url(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))}
export function random(){return base64url(crypto.getRandomValues(new Uint8Array(32)))}
async function cryptKey(env:Env){if(!env.KEY)fail(503,'Credential storage is not configured.');return crypto.subtle.importKey('raw',bytes(env.KEY),'AES-GCM',false,['encrypt','decrypt'])}
export async function seal(env:Env,context:string,value:string){const iv=crypto.getRandomValues(new Uint8Array(12));return base64url(iv)+'.'+base64url(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(context)},await cryptKey(env),new TextEncoder().encode(value)))}
export async function open(env:Env,context:string,box:string){const [iv,data]=box.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:new TextEncoder().encode(context)},await cryptKey(env),bytes(data)))}
export async function rows<T>(db:D1Database,sql:string,...args:unknown[]){return (await db.prepare(sql).bind(...args).all<T>()).results}
export const now=()=>Math.floor(Date.now()/1000);
