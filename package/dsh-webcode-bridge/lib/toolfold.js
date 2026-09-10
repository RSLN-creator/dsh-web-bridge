// toolfold.js — 注入网页面板的「工具调用折叠」前端脚本。
//
// 网页模型按协议输出 ```json / <tool_call> 形态的工具调用与结果，在对话流里
// 是一大段 JSON，既占屏幕又打断阅读。这段脚本把这类代码块换成一行摘要
// （工具名 + 首个参数 + 结果状态），点击才展开原文。
//
// 不改站点 DOM 结构：只在 <pre> 前插一个 header，并切换该 <pre> 的 display。
// 用 MutationObserver 跟随流式渲染，纯字符串匹配判定（不用正则，避免转义失真）。

export const TOOL_FOLD_HTML = `
<style data-webcode-toolfold>
.hwb-tf-head{display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.6;padding:3px 8px;margin:6px 0;border:1px solid #8884;border-radius:6px;background:#8881;cursor:pointer;user-select:none;color:inherit;font-family:inherit}
.hwb-tf-head:hover{background:#8882}
.hwb-tf-caret{display:inline-block;font-size:9px;opacity:.55;transition:transform .15s}
.hwb-tf-head.open .hwb-tf-caret{transform:rotate(90deg)}
.hwb-tf-name{font-weight:600;white-space:nowrap}
.hwb-tf-tag{opacity:.6;font-size:11px;border:1px solid #8884;border-radius:4px;padding:0 5px;white-space:nowrap}
.hwb-tf-tag.ok{color:#2e7d32;border-color:#2e7d3280}
.hwb-tf-tag.bad{color:#93443e;border-color:#93443e80}
.hwb-tf-args{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
</style>
<script data-webcode-toolfold>(function(){
if(window.__webcodeToolFold)return;window.__webcodeToolFold=1;

// 取 JSON 里某个键的字符串值（纯扫描，不用正则）
function pick(t,key){
  var k=String.fromCharCode(34)+key+String.fromCharCode(34);
  var i=t.indexOf(k);
  if(i<0)return "";
  i=t.indexOf(":",i);if(i<0)return "";
  var q=String.fromCharCode(34);
  var a=t.indexOf(q,i);if(a<0)return "";
  var b=t.indexOf(q,a+1);if(b<0)return "";
  return t.slice(a+1,b);
}

// 判定这段文本是不是工具调用/结果；不是则返回 null
function classify(t){
  var hasAction=t.indexOf("mcp_action")>=0;
  var tagged=t.indexOf("tool_call")>=0;
  if(!hasAction&&!tagged)return null;
  var isResult=hasAction&&t.indexOf("result")>=0;
  var isCall=(hasAction&&t.indexOf("call")>=0)||tagged;
  if(!isCall&&!isResult)return null;
  return {name:pick(t,"name"),isResult:isResult,status:pick(t,"status")};
}

// arguments 里的第一个键值对，作为一行摘要（如 command: Get-ChildItem）
function firstArg(t){
  var i=t.indexOf("arguments");
  if(i<0)return "";
  i=t.indexOf(":",i);if(i<0)return "";
  var q=String.fromCharCode(34);
  // 跳过 arguments 值的起始，取第一个键
  var k1=t.indexOf(q,i);if(k1<0)return "";
  var k2=t.indexOf(q,k1+1);if(k2<0)return "";
  var key=t.slice(k1+1,k2);
  // 键后找冒号，再找值的起始引号
  var c=t.indexOf(":",k2);if(c<0)return key;
  var v1=t.indexOf(q,c);if(v1<0)return key;
  var v2=t.indexOf(q,v1+1);if(v2<0)return key;
  var val=t.slice(v1+1,v2);
  if(!val)return key;
  // 值太长时截断（CSS 另有省略，但先截可少传字符）
  if(val.length>60)val=val.slice(0,60)+"\u2026";
  return key+": "+val;
}

var folded=[];
function already(pre){for(var i=0;i<folded.length;i++)if(folded[i]===pre)return true;return false;}

function fold(pre){
  if(!pre||already(pre))return;
  var t=pre.textContent||"";
  if(t.length<16)return;
  var info=classify(t);
  if(!info)return;
  var host=pre.parentNode;if(!host)return;
  folded.push(pre);

  var head=document.createElement("div");
  head.className="hwb-tf-head";
  head.title="点击展开 / 收起原文";

  var caret=document.createElement("span");
  caret.className="hwb-tf-caret";
  caret.textContent="\u25B6";
  head.appendChild(caret);

  var label=document.createElement("span");
  label.className="hwb-tf-name";
  var fallback=info.isResult?"工具结果":"工具调用";
  label.textContent=(info.isResult?"\u2713 ":"\u2699 ")+(info.name||fallback);
  head.appendChild(label);

  if(info.isResult&&info.status){
    var tag=document.createElement("span");
    tag.className="hwb-tf-tag "+(info.status==="success"?"ok":"bad");
    tag.textContent=info.status;
    head.appendChild(tag);
  }

  var args=document.createElement("span");
  args.className="hwb-tf-args";
  var fa=info.isResult?"":firstArg(t);
  args.textContent=fa||(t.length+" 字符");
  head.appendChild(args);

  pre.style.display="none";
  head.addEventListener("click",function(){
    var open=head.classList.toggle("open");
    pre.style.display=open?"":"none";
  });
  host.insertBefore(head,pre);
}

function scan(){
  var pres=document.querySelectorAll("pre");
  for(var i=0;i<pres.length;i++){try{fold(pres[i]);}catch(e){}}
}

var timer=null;
function schedule(){if(timer)return;timer=setTimeout(function(){timer=null;scan();},260);}

function mount(){
  if(!document.body)return;
  scan();
  try{new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true,characterData:true});}catch(e){}
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount);else mount();
})();</script>
`;
