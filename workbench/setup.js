const $=id=>document.getElementById(id);
const fragment=location.hash.slice(1);
if(fragment){sessionStorage.setItem('harness-setup',fragment);history.replaceState(null,'',location.pathname);}
const token=sessionStorage.getItem('harness-setup');
let state={};let posting=false;let workspaceInitialized=false;
async function api(route,body){
  const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'x-mycodex-setup':token??'',...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
  const value=await response.json();if(!response.ok)throw Error(value.error??'本机操作失败。');return value;
}
function notice(text,ok=false){$('message').textContent=text;$('message').hidden=!text;$('message').dataset.ok=String(ok);}
function render(){
  $('badge').textContent=posting||state.busy?'正在启动':state.ready?'运行中':'等待配置';
  $('saved').textContent=state.keySaved?'已加密保存':state.keyAvailable?'仅本次运行可用':'';
  if(!workspaceInitialized){$('workspace').value=state.workspace??'';workspaceInitialized=true;}
  $('workspace').readOnly=Boolean(state.workspaceLocked);
  if(state.workspaceLocked){$('workspace').value=state.workspace??'';$('workspace-hint').textContent='初始项目已建立。其它项目请在 Harness 工作台的侧栏中选择或添加。';}
  $('key').placeholder=state.keyAvailable?'已配置，留空继续使用当前 Key':'在本机输入 DeepSeek API Key';
  $('open').hidden=!state.ready;$('stop').hidden=!state.ready;$('forget').hidden=!state.keyAvailable&&!state.keySaved;
  for(const id of ['connect','open','stop','forget'])$(id).disabled=posting||state.busy;
}
function openWorkbench(){if(state.url){const url=new URL(state.url);if(url.protocol==='http:'&&url.hostname==='127.0.0.1')location.assign(url.href);}}
$('setup').addEventListener('submit',async event=>{
  event.preventDefault();posting=true;render();notice('正在验证配置并启动工作台…',true);
  const body={key:$('key').value,workspace:$('workspace').value,remember:$('remember').checked};$('key').value='';
  try{state=await api('/api/connect',body);notice('工作台已就绪。',true);openWorkbench();}catch(error){notice(error.message);}finally{body.key='';posting=false;render();}
});
$('open').addEventListener('click',openWorkbench);
$('stop').addEventListener('click',async()=>{if(!confirm('停止工作台会中断其任务和终端进程。'))return;try{state=await api('/api/stop',{});render();notice('工作台已停止。',true);}catch(error){notice(error.message);}});
$('forget').addEventListener('click',async()=>{if(!confirm('清除 Key 会停止当前工作台。'))return;try{state=await api('/api/forget',{});$('key').value='';render();notice('已清除保存的 Key。',true);}catch(error){notice(error.message);}});
async function refresh(){try{state=await api('/api/status');render();if(state.error)notice(state.error);}catch(error){notice(error.message);}}
void refresh();setInterval(()=>{if(!posting)void refresh();},3000);
