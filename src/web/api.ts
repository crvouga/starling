export class ApiError extends Error{constructor(public status:number,message:string){super(message)}}
export async function api<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST',signal?:AbortSignal):Promise<T>{
 const res=await fetch('/api/'+path,{method,signal,headers:body!==undefined?{'content-type':'application/json'}:{},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await res.json() as {error?:string};if(!res.ok)throw new ApiError(res.status,data.error??'Request failed.');return data as T
}
export const providerName=(p:string)=>p==='claude'?'Claude Code':'Codex';
