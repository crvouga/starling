import {z} from 'zod';
export const controlRequest=z.object({type:z.literal('control_request'),request_id:z.string().max(180),request:z.object({subtype:z.literal('can_use_tool'),tool_name:z.string().max(120),input:z.record(z.string(),z.unknown())})});
export function answerPermission(id:string,input:Record<string,unknown>,allow:boolean){
 return {type:'control_response',response:{subtype:'success',request_id:id,response:allow?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'The reviewer declined this action.'}}}
}
