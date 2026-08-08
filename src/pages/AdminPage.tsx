import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, BadgeDollarSign, Building2, ChartNoAxesCombined, ChevronRight, CircleDollarSign, Landmark, Plus, RotateCcw, Save, ShieldCheck, Users } from 'lucide-react';
import { Modal, Notice } from '@/components/Modal';

type Module = 'users'|'private'|'secondary'|'agency'|'earnings';
type UserRow = {id:string;email:string;joined:string;balance:number;role:string};
type Placement = {id:number;name:string;raised:number;target:number;price:number;minimum:number};
type MarketAsset = {id:number;name:string;price:number;change:number;volume:number};
type Agent = {id:number;name:string;level:number;parent?:string;rate:number};

const modules = [
 {id:'users' as const,label:'用戶管理',short:'用戶',icon:Users},
 {id:'private' as const,label:'私募標的物管理',short:'私募',icon:Building2},
 {id:'secondary' as const,label:'二級市場標的物',short:'市場',icon:ChartNoAxesCombined},
 {id:'agency' as const,label:'總代理及代理結構',short:'代理',icon:ShieldCheck},
 {id:'earnings' as const,label:'收益與結算報表',short:'收益',icon:BadgeDollarSign},
];
const initialUsers:UserRow[]=[
 {id:'usr_8fa2',email:'nick800142@gmail.com',joined:'2026/07/18',balance:128450,role:'總代理'},
 {id:'usr_17bc',email:'lin.wei@example.com',joined:'2026/07/22',balance:36200,role:'一代代理'},
 {id:'usr_44de',email:'mei.chen@example.com',joined:'2026/07/29',balance:18400,role:'一般用戶'},
 {id:'usr_62aa',email:'kai.wu@example.com',joined:'2026/08/03',balance:9700,role:'二代代理'},
];
const initialPlacements:Placement[]=[
 {id:1,name:'台北信義商辦 A 棟',raised:720000,target:1000000,price:100,minimum:1000},
 {id:2,name:'台中七期複合商場',raised:415000,target:800000,price:80,minimum:800},
 {id:3,name:'高雄亞灣物流中心',raised:186000,target:600000,price:60,minimum:600},
];
const initialMarkets:MarketAsset[]=[
 {id:1,name:'信義商辦 RWMT-X1',price:104.8,change:2.4,volume:182400},
 {id:2,name:'七期商場 RWMT-C7',price:78.2,change:-1.1,volume:93600},
 {id:3,name:'亞灣物流 RWMT-KH',price:62.6,change:0.8,volume:55800},
];
const initialAgents:Agent[]=[
 {id:1,name:'北區總代理',level:0,rate:12},{id:2,name:'台北一代 A',level:1,parent:'北區總代理',rate:8},{id:3,name:'信義二代 A-1',level:2,parent:'台北一代 A',rate:4},
 {id:4,name:'中南區總代理',level:0,rate:11},{id:5,name:'台中一代 B',level:1,parent:'中南區總代理',rate:7},{id:6,name:'高雄二代 B-1',level:2,parent:'台中一代 B',rate:3.5},
];

export function AdminPage({onExit}:{onExit:()=>void}){
 const[module,setModule]=useState<Module>('users');
 return <div className="min-h-screen">
  <div className="flex min-h-screen flex-col lg:flex-row">
   <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-900/60 p-5 lg:flex lg:flex-col">
    <div className="border-b border-slate-800 pb-5"><p className="text-xs font-bold tracking-[.18em] text-amber-300">RWMT CONTROL</p><h1 className="mt-2 text-xl font-bold text-white">後台管理中心</h1><p className="mt-1 text-xs text-slate-500">前端模擬資料模式</p></div>
    <nav className="mt-5 flex flex-1 flex-col gap-1" aria-label="後台管理模組">{modules.map(({id,label,icon:Icon})=><button key={id} onClick={()=>setModule(id)} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition ${module===id?'bg-amber-400 text-slate-950':'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><Icon className="size-5"/>{label}</button>)}</nav>
    <button onClick={onExit} className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"><ArrowLeft className="size-4"/>返回前台網站</button>
   </aside>
   <div className="min-w-0 flex-1">
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 py-4 sm:px-6 lg:px-8"><div><p className="text-xs font-bold text-amber-300 lg:hidden">RWMT ADMIN</p><h2 className="text-lg font-bold text-white">{modules.find(item=>item.id===module)?.label}</h2></div><button onClick={onExit} className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 lg:hidden"><ArrowLeft className="size-4"/>前台</button></header>
    <nav className="flex overflow-x-auto border-b border-slate-800 bg-slate-900/50 p-2 lg:hidden" aria-label="後台管理模組">{modules.map(({id,short,icon:Icon})=><button key={id} onClick={()=>setModule(id)} className={`flex min-w-20 flex-1 flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium ${module===id?'bg-amber-400 text-slate-950':'text-slate-400'}`}><Icon className="size-4"/>{short}</button>)}</nav>
    <main className="p-4 pb-28 sm:p-6 lg:p-8">{module==='users'&&<UsersModule/>}{module==='private'&&<PrivateModule/>}{module==='secondary'&&<SecondaryModule/>}{module==='agency'&&<AgencyModule/>}{module==='earnings'&&<EarningsModule/>}</main>
   </div>
  </div>
 </div>;
}

function UsersModule(){
 const[users,setUsers]=useState(initialUsers);const[notice,setNotice]=useState('');
 const reset=(user:UserRow)=>{if(!confirm(`確定清空 ${user.email} 的模擬餘額？`))return;setUsers(rows=>rows.map(row=>row.id===user.id?{...row,balance:0}:row));setNotice(`已清空 ${user.email} 的模擬餘額`)};
 const changeRole=(user:UserRow)=>{const roles=['一般用戶','二代代理','一代代理','總代理'];const next=roles[(roles.indexOf(user.role)+1)%roles.length];setUsers(rows=>rows.map(row=>row.id===user.id?{...row,role:next}:row));setNotice(`${user.email} 已變更為${next}`)};
 return <Panel title="用戶與帳戶" description="管理已註冊帳戶、模擬餘額及代理身份。">{notice&&<Notice message={notice}/>}<Table><thead><tr><Th>用戶</Th><Th>註冊時間</Th><Th>餘額</Th><Th>身份</Th><Th>操作</Th></tr></thead><tbody className="divide-y divide-slate-800">{users.map(user=><tr key={user.id}><Td><b className="text-slate-200">{user.email}</b><span className="block text-xs text-slate-500">{user.id}</span></Td><Td>{user.joined}</Td><Td>{user.balance.toLocaleString()} USDT</Td><Td><Tag>{user.role}</Tag></Td><Td><div className="flex gap-2"><SmallButton onClick={()=>reset(user)} danger><RotateCcw className="size-3"/>清空餘額</SmallButton><SmallButton onClick={()=>changeRole(user)}>變更身份</SmallButton></div></Td></tr>)}</tbody></Table></Panel>
}

function PrivateModule(){
 const[items,setItems]=useState(initialPlacements);const[open,setOpen]=useState(false);const[error,setError]=useState('');const[notice,setNotice]=useState('');
 const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const fd=new FormData(event.currentTarget);const name=String(fd.get('name')||'').trim();const target=Number(fd.get('target'));const price=Number(fd.get('price'));const minimum=Number(fd.get('minimum'));if(!name||[target,price,minimum].some(v=>!Number.isFinite(v)||v<=0)){setError('請填寫名稱，且所有金額必須大於 0。');return}setItems(rows=>[...rows,{id:Date.now(),name,raised:0,target,price,minimum}]);setOpen(false);setError('');setNotice(`已新增模擬標的「${name}」`)};
 return <Panel title="私募標的物" description="追蹤招募進度並建立新的代幣化資產。" action={<button onClick={()=>setOpen(true)} className="flex items-center gap-2 rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950"><Plus className="size-4"/>新增標的物</button>}>{notice&&<Notice message={notice}/>}<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{items.map(item=>{const pct=Math.min(100,item.raised/item.target*100);return <article key={item.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><div className="flex items-start justify-between gap-3"><h3 className="font-bold text-white">{item.name}</h3><Tag>{pct.toFixed(0)}%</Tag></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-amber-400" style={{width:`${pct}%`}}/></div><p className="mt-3 text-sm text-slate-400">{item.raised.toLocaleString()} / {item.target.toLocaleString()} USDT</p><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><Metric label="單價" value={`${item.price} USDT`}/><Metric label="起投" value={`${item.minimum} USDT`}/></div></article>})}</div><Modal open={open} onClose={()=>setOpen(false)} title="新增私募標的"><form onSubmit={submit} className="flex flex-col gap-4">{error&&<Notice message={error} tone="error"/>}<Field label="標的名稱" name="name" placeholder="例：新竹科技園區辦公樓"/><Field label="目標金額 (USDT)" name="target" type="number" min="1"/><Field label="代幣單價 (USDT)" name="price" type="number" min="0.01" step="0.01"/><Field label="起投門檻 (USDT)" name="minimum" type="number" min="1"/><button className="mt-2 rounded-xl bg-amber-400 px-4 py-3 font-bold text-slate-950">建立模擬標的</button></form></Modal></Panel>
}

function SecondaryModule(){
 const[assets,setAssets]=useState(initialMarkets);const[selected,setSelected]=useState(1);const[price,setPrice]=useState('104.8');const[notice,setNotice]=useState('');
 const choose=(id:number)=>{const asset=assets.find(a=>a.id===id)!;setSelected(id);setPrice(String(asset.price))};
 const save=()=>{const value=Number(price);if(!Number.isFinite(value)||value<=0){setNotice('價格必須大於 0');return}setAssets(rows=>rows.map(a=>a.id===selected?{...a,price:value}:a));setNotice('模擬市場價格已更新')};
 return <Panel title="二級市場標的" description="檢視市場表現，並在測試模式中調整成交價格。">{notice&&<Notice message={notice} tone={notice.includes('必須')?'error':'success'}/>}<div className="grid gap-5 xl:grid-cols-[1fr_320px]"><Table><thead><tr><Th>標的</Th><Th>價格</Th><Th>24h 漲跌</Th><Th>成交量</Th></tr></thead><tbody className="divide-y divide-slate-800">{assets.map(asset=><tr key={asset.id} onClick={()=>choose(asset.id)} className={`cursor-pointer ${selected===asset.id?'bg-slate-800/70':'hover:bg-slate-800/40'}`}><Td><b className="text-slate-200">{asset.name}</b></Td><Td>{asset.price.toFixed(2)} USDT</Td><Td><span className={asset.change>=0?'text-emerald-400':'text-red-400'}>{asset.change>=0?'+':''}{asset.change}%</span></Td><Td>{asset.volume.toLocaleString()} USDT</Td></tr>)}</tbody></Table><section className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><h3 className="font-bold text-white">動態調整價格</h3><p className="mt-1 text-xs text-slate-500">僅更新前端測試資料</p><label className="mt-5 block text-sm text-slate-400">新價格 (USDT)<input value={price} onChange={e=>setPrice(e.target.value)} type="number" min="0.01" step="0.01" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white"/></label><button onClick={save} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 font-bold text-slate-950"><Save className="size-4"/>套用價格</button></section></div></Panel>
}

function AgencyModule(){
 const[agents,setAgents]=useState(initialAgents);const[notice,setNotice]=useState('');
 const update=(id:number,value:string)=>{const rate=Math.max(0,Math.min(100,Number(value)||0));setAgents(rows=>rows.map(agent=>agent.id===id?{...agent,rate}:agent))};
 return <Panel title="代理層級與分潤" description="維護總代理、一代與二代結構及個別分潤比例。">{notice&&<Notice message={notice}/>}<div className="flex flex-col gap-3">{agents.map(agent=><article key={agent.id} className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4 sm:flex-row sm:items-center" style={{marginLeft:`${Math.min(agent.level*20,40)}px`}}><div className="flex flex-1 items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-slate-800"><Landmark className="size-4 text-amber-300"/></div><div><p className="font-semibold text-white">{agent.name}</p><p className="text-xs text-slate-500">{['總代理','一代代理','二代代理'][agent.level]}{agent.parent?` · 上層：${agent.parent}`:''}</p></div></div><label className="flex items-center gap-2 text-sm text-slate-400">分潤<input aria-label={`${agent.name} 分潤比例`} type="number" min="0" max="100" step="0.5" value={agent.rate} onChange={e=>update(agent.id,e.target.value)} className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-right text-white"/>%</label><SmallButton onClick={()=>setNotice(`${agent.name} 的模擬分潤已設為 ${agent.rate}%`)}>儲存</SmallButton></article>)}</div></Panel>
}

function EarningsModule(){
 const[settled,setSettled]=useState(false);const[busy,setBusy]=useState(false);const monthly=[42,58,49,74,66,88];
 const settle=()=>{if(!confirm('確定執行本期模擬收益結算？'))return;setBusy(true);setTimeout(()=>{setBusy(false);setSettled(true)},700)};
 return <Panel title="收益與結算" description="檢視平台收入、代理佣金及最近六期趨勢。">{settled&&<Notice message="本期模擬收益已完成結算"/>}<div className="grid gap-4 sm:grid-cols-3"><Stat label="平台總收益" value="486,240 USDT"/><Stat label="待結代理佣金" value={settled?'0 USDT':'72,936 USDT'}/><Stat label="本期淨收益" value="413,304 USDT"/></div><section className="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="font-bold text-white">收益趨勢</h3><p className="mt-1 text-xs text-slate-500">近六個月，單位：千 USDT</p></div><button onClick={settle} disabled={busy||settled} className="flex items-center justify-center gap-2 rounded-xl bg-amber-400 px-4 py-3 text-sm font-bold text-slate-950 disabled:opacity-50"><CircleDollarSign className="size-4"/>{busy?'結算中…':settled?'本期已結算':'一鍵結算收益'}</button></div><div className="mt-8 flex h-52 items-end gap-3" aria-label="收益長條圖">{monthly.map((value,index)=><div key={index} className="flex flex-1 flex-col items-center justify-end gap-2"><span className="text-xs text-slate-400">{value}</span><div className="w-full max-w-16 rounded-t-lg bg-amber-400" style={{height:`${value*1.7}px`}}/><span className="text-xs text-slate-500">{index+3}月</span></div>)}</div></section></Panel>
}

function Panel({title,description,action,children}:{title:string;description:string;action?:ReactNode;children:ReactNode}){return <div className="flex flex-col gap-5"><header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-2xl font-bold text-white">{title}</h2><p className="mt-1 text-sm text-slate-400">{description}</p></div>{action}</header>{children}</div>}
function Table({children}:{children:ReactNode}){return <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900"><table className="w-full min-w-[720px] text-left text-sm">{children}</table></div>}
function Th({children}:{children:ReactNode}){return <th className="border-b border-slate-800 px-5 py-3 font-medium text-slate-500">{children}</th>}
function Td({children}:{children:ReactNode}){return <td className="px-5 py-4 text-slate-400">{children}</td>}
function Tag({children}:{children:ReactNode}){return <span className="inline-flex rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-300">{children}</span>}
function SmallButton({children,onClick,danger=false}:{children:ReactNode;onClick:()=>void;danger?:boolean}){return <button onClick={onClick} className={`flex whitespace-nowrap items-center gap-1 rounded-lg border px-3 py-2 text-xs font-semibold ${danger?'border-red-500/30 text-red-300 hover:bg-red-500/10':'border-slate-700 text-slate-300 hover:bg-slate-800'}`}>{children}<ChevronRight className="size-3"/></button>}
function Field({label,...props}:{label:string;name:string;type?:string;placeholder?:string;min?:string;step?:string}){return <label className="text-sm text-slate-300">{label}<input {...props} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-white placeholder:text-slate-600"/></label>}
function Metric({label,value}:{label:string;value:string}){return <div className="rounded-lg bg-slate-950 p-3"><p className="text-slate-500">{label}</p><p className="mt-1 font-semibold text-slate-200">{value}</p></div>}
function Stat({label,value}:{label:string;value:string}){return <article className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">{label}</p><p className="mt-2 text-xl font-bold text-white">{value}</p></article>}
