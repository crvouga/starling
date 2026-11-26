import {useRef,useState} from 'react';
import {ChatConversation,ChatMessage,ChatTool,PromptInput} from '@heroui-pro/react';
import {Markdown} from '@heroui-pro/react/markdown';
import {Button,Chip} from '@heroui/react';
import {Paperclip,Square} from 'lucide-react';
import '@heroui-pro/react/css';
export default function Conversation({events,locked,active,send,cancel}){
 const [value,setValue]=useState(''),[file,setFile]=useState();const input=useRef(null);
 const submit=async()=>{if(!locked&&value.trim()&&await send(value,file)){setValue('');setFile(undefined)}};
 return <><ChatConversation className="min-h-0 flex-1" aria-label="Agent conversation"><ChatConversation.Content className="mx-auto w-full max-w-3xl space-y-4 p-5">
 {events.map(e=>e.kind==='user'?<ChatMessage.User key={e.id}><ChatMessage.Bubble><ChatMessage.Content>{e.body}</ChatMessage.Content></ChatMessage.Bubble></ChatMessage.User>:e.kind==='assistant'?<ChatMessage.Assistant key={e.id}><ChatMessage.Body><ChatMessage.Content><Markdown>{e.body}</Markdown></ChatMessage.Content></ChatMessage.Body></ChatMessage.Assistant>:e.kind==='tool'?<ChatTool key={e.id} state="output-available" toolName="Tool activity"><ChatTool.Trigger><ChatTool.StatusIcon/>{e.body.split('\n')[0].slice(0,70)}</ChatTool.Trigger><ChatTool.Content><ChatTool.Result label="Output" value={e.body}/></ChatTool.Content></ChatTool>:<p key={e.id} className="text-xs text-muted">{e.body}</p>)}
 </ChatConversation.Content><ChatConversation.ScrollButton/></ChatConversation>
 <div className="p-4"><PromptInput value={value} onValueChange={setValue} onSubmit={submit}><PromptInput.Shell><PromptInput.Content>{file&&<Chip>{file.name}<Button size="sm" variant="ghost" onPress={()=>setFile(undefined)}>Remove</Button></Chip>}<PromptInput.TextArea aria-label="Message" placeholder="Describe the next change…"/></PromptInput.Content><PromptInput.Toolbar><PromptInput.ToolbarStart><PromptInput.Action aria-label="Attach an image" onPress={()=>input.current?.click()}><Paperclip size={16}/></PromptInput.Action><input ref={input} hidden type="file" accept="image/jpeg,image/png" onChange={e=>setFile(e.target.files?.[0])}/></PromptInput.ToolbarStart><PromptInput.ToolbarEnd>{active?<Button isIconOnly aria-label="Stop execution" onPress={cancel}><Square size={14}/></Button>:<PromptInput.Send isDisabled={locked||!value.trim()}/>}</PromptInput.ToolbarEnd></PromptInput.Toolbar></PromptInput.Shell></PromptInput></div></>
}
