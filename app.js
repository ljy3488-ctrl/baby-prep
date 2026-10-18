/* GitHub Pages UI. SECRET is entered by the user, never hardcoded in repository. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const won = n => Number(n || 0).toLocaleString('ko-KR') + '원';
  const sessionKey = 'bp-active-secret-v1';
  const state = {items: [], secret: sessionStorage.getItem(sessionKey) || '', saving:false, active:null};
  const API = String(window.BABY_PREP_API_URL || '').trim();

  function notify(text,kind='info') {
    const el=$('#message');el.textContent=text;el.className='message show '+kind;
    const editError=$('#editorStatus');
    if($('#editor').open && kind==='error'){editError.textContent=text;editError.hidden=false;}
  }
  function clearNotice() {$('#message').className='message';$('#message').textContent='';}
  function busy(button,on,caption) {
    button.disabled=on;
    if(on){button.dataset.prevText=button.textContent;button.textContent=caption;}
    else if(button.dataset.prevText){button.textContent=button.dataset.prevText;delete button.dataset.prevText;}
  }
  function nonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function signature(method,ts,random,action,data) {
    const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(state.secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const text=[method,ts,random,action,data].join('\n');
    const out=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text));
    const str=String.fromCharCode(...new Uint8Array(out));
    return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function checkConfig() {
    if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\/?$/.test(API)) {
      throw new Error('config.js 파일에 Apps Script /exec 주소를 입력해야 합니다.');
    }
  }
  async function listFromSheets() {
    checkConfig();
    const random=nonce(), ts=String(Date.now()), callback='babyCb_'+random;
    const sig=await signature('GET',ts,random,'list',callback);
    const params=new URLSearchParams({action:'list',ts,nonce:random,callback,sig});
    return await new Promise((resolve,reject)=>{
      const script=document.createElement('script');let settled=false;
      const timeout=setTimeout(()=>finish(new Error('응답 시간이 초과되었습니다. 인터넷 연결과 배포 권한을 확인하세요.')),30000);
      function finish(error,data) {
        if(settled)return;settled=true;clearTimeout(timeout);delete window[callback];script.remove();
        error?reject(error):resolve(data);
      }
      window[callback]=data=>finish(null,data);
      script.onerror=()=>finish(new Error('Google Apps Script 응답을 읽지 못했습니다. 배포 URL과 액세스 권한을 확인하세요.'));
      script.src=API+'?'+params.toString();
      document.head.appendChild(script);
    });
  }
  async function getItems() {
    const data=await listFromSheets();
    if(!data || !data.ok)throw new Error((data && data.error)||'목록을 불러오지 못했습니다.');
    if(!Array.isArray(data.items))throw new Error('서버 목록 형식이 올바르지 않습니다.');
    return data.items.map(r=>({
      id:String(r.ID||''), category:String(r['카테고리']||''),name:String(r['품목']||''),
      qty:Number(r['권장수량']||0),priority:String(r['우선순위']||''),estimate:Number(r['예상금액']||0),
      status:String(r['구매상태']||'미구매'),price:Number(r['실제금액']||0),
      product:String(r['구매제품']||''),memo:String(r['메모']||''),updated:String(r['수정일시']||'')
    }));
  }
  function drawCategories() {
    const select=$('#category'),selected=select.value;
    select.replaceChildren(new Option('전체 카테고리',''));
    for(const cat of new Set(state.items.map(i=>i.category))){select.add(new Option(cat,cat));}
    if([...select.options].some(o=>o.value===selected))select.value=selected;
  }
  function render() {
    const completed=state.items.filter(i=>i.status==='구매완료'||i.status==='선물받음').length;
    $('#progress').textContent=completed+' / '+state.items.length;
    $('#bar').style.width=(state.items.length?100*completed/state.items.length:0)+'%';
    $('#spent').textContent=won(state.items.reduce((v,i)=>v+(Number(i.price)||0),0));
    $('#estimate').textContent='필수 예상 '+won(state.items.filter(i=>i.priority==='필수').reduce((v,i)=>v+(Number(i.estimate)||0),0));
    const q=$('#search').value.trim().toLowerCase(),cat=$('#category').value, status=$('#status').value;
    const selected=state.items.filter(i=>(!cat||i.category===cat)&&(!status||i.status===status)&&(!q||(i.name+' '+i.product+' '+i.memo).toLowerCase().includes(q)));
    $('#count').textContent=selected.length+'개 표시';
    const wrap=$('#items');wrap.replaceChildren();
    for(const i of selected){
      const complete=i.status==='구매완료'||i.status==='선물받음';
      const item=document.createElement('article');item.className='item'+(complete?' done':'');
      const chk=document.createElement('button');chk.type='button';chk.className='check';chk.textContent=complete?'✓':'';
      chk.setAttribute('aria-label',i.name+' 구매 완료 변경');chk.disabled=state.saving;
      chk.addEventListener('click',()=>save(i.id,{구매상태:i.status==='구매완료'?'미구매':'구매완료'}));
      const info=document.createElement('div');info.className='item-content';
      const title=document.createElement('div');title.className='item-title';title.textContent=i.name;
      const meta=document.createElement('div');meta.className='item-meta';meta.textContent=`${i.category} · ${i.priority} · 권장 ${i.qty}개 · ${i.status}`;
      const price=document.createElement('div');price.className='item-price';price.textContent=`예상 ${won(i.estimate)} · 실제 ${won(i.price)}`;
      info.append(title,meta,price);
      if(i.product || i.memo){const note=document.createElement('div');note.className='item-note';note.textContent=[i.product,i.memo].filter(Boolean).join(' · ');info.append(note);}
      const edit=document.createElement('button');edit.type='button';edit.className='edit';edit.textContent='수정';edit.disabled=state.saving;edit.addEventListener('click',()=>openEditor(i));
      item.append(chk,info,edit);wrap.append(item);
    }
  }
  async function load(showMessage=true) {
    const items=await getItems();state.items=items;drawCategories();render();
    $('#syncLabel').textContent='Google Sheets 연결됨 · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
    if(showMessage) notify('Google Sheets의 최신 정보를 불러왔습니다.','success');
  }
  function showDashboard(on){$('#loginPanel').hidden=on;$('#dashboard').hidden=!on;}
  async function login(secret) {
    state.secret=secret;
    busy($('#connectBtn'),true,'연결하는 중…');notify('Google Sheets 연결을 확인하고 있습니다.');
    try {
      await load(false);
      sessionStorage.setItem(sessionKey,state.secret);showDashboard(true);
      notify('연결되었습니다. 모든 변경 사항은 Google Sheets에 저장됩니다.','success');
    } catch(err){sessionStorage.removeItem(sessionKey);state.secret='';showDashboard(false);notify(err.message,'error');}
    finally{busy($('#connectBtn'),false);}
  }
  async function sendSave(id,changes) {
    const payload=JSON.stringify({id,changes}),random=nonce(),ts=String(Date.now());
    const sig=await signature('POST',ts,random,'save',payload);
    const body=new URLSearchParams({action:'save',ts,nonce:random,payload,sig});
    // Avoid CORS preflight. Response is opaque, so a fresh signed GET verifies the saved data.
    await fetch(API,{method:'POST',mode:'no-cors',body,redirect:'follow',cache:'no-store'});
  }
  function matches(id,changes) {
    const current=state.items.find(i=>i.id===id);if(!current)return false;
    const m={구매상태:'status',실제금액:'price',구매제품:'product',메모:'memo'};
    return Object.entries(changes).every(([key,val])=>String(current[m[key]])===String(val));
  }
  async function save(id,changes) {
    if(state.saving)return false;
    state.saving=true;render();notify('저장하고 있습니다.');
    let networkError;
    try{await sendSave(id,changes);}catch(e){networkError=e;}
    try {
      // Read-after-write confirms results even when cross-origin POST response is opaque.
      await new Promise(resolve=>setTimeout(resolve,350));
      await load(false);
      if(!matches(id,changes)) {
        await new Promise(resolve=>setTimeout(resolve,900));await load(false);
      }
      if(!matches(id,changes))throw new Error(networkError?'저장 요청 또는 확인에 실패했습니다. 네트워크를 확인하세요.':'저장 결과를 확인하지 못했습니다. Apps Script 실행 로그를 확인하세요.');
      notify('저장 완료! 다른 휴대폰에서도 새로고침하면 보입니다.','success');return true;
    } catch(err){notify(err.message,'error');return false;}
    finally{state.saving=false;render();}
  }
  function openEditor(i) {
    state.active=i.id;$('#editorStatus').hidden=true;$('#editorStatus').textContent='';
    $('#editTitle').textContent=i.name;
    $('#editStatus').value=i.status;$('#editPrice').value=i.price;
    $('#editProduct').value=i.product;$('#editMemo').value=i.memo;
    $('#editor').showModal();
  }
  $('#connectForm').addEventListener('submit',e=>{e.preventDefault();const secret=$('#secretInput').value;if(secret.length<16){notify('SECRET은 16자 이상 입력하세요.','error');return;}login(secret);});
  $('#logoutBtn').addEventListener('click',()=>{sessionStorage.removeItem(sessionKey);state.secret='';state.items=[];$('#secretInput').value='';showDashboard(false);notify('연결을 해제했습니다.','info');});
  $('#refreshBtn').addEventListener('click',async()=>{
    if(state.saving)return;const button=$('#refreshBtn');busy(button,true,'불러오는 중…');
    try{await load();}catch(e){notify(e.message,'error');}finally{busy(button,false);}
  });
  $('#cancelBtn').addEventListener('click',()=>$('#editor').close());
  $('#editForm').addEventListener('submit',async e=>{
    e.preventDefault();if(!state.active||state.saving)return;
    const p=Number($('#editPrice').value||0);
    if(!Number.isSafeInteger(p)||p<0||p>100000000){notify('구매 금액을 올바르게 입력하세요.','error');return;}
    const changes={구매상태:$('#editStatus').value,실제금액:p,구매제품:$('#editProduct').value,메모:$('#editMemo').value};
    busy($('#saveBtn'),true,'저장하는 중…');
    try{if(await save(state.active,changes))$('#editor').close();}finally{busy($('#saveBtn'),false);}
  });
  for(const id of ['search','category','status'])$('#'+id).addEventListener(id==='search'?'input':'change',render);
  if(state.secret){login(state.secret);}else if(!API){notify('먼저 config.js에 Apps Script 배포 URL을 입력하세요.','info');}
})();
