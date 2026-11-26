import type {Activity,Session} from '../shared';
export type ChatProps={session:Session;events:Activity[];locked:boolean;active:boolean;send:(text:string,file?:File)=>Promise<boolean>;cancel:()=>void};
