/* GitHub Pages UI. SECRET is entered by the user, never hardcoded in repository. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const won = n => Number(n || 0).toLocaleString('ko-KR') + '원';
  // Keep the API URL in config.js, and store the user's SECRET only on this device.
  const storageKey = 'bp-device-secret-v2';
  const oldSessionKey = 'bp-active-secret-v1';
  const cacheKey = 'bp-items-cache-v3';
  const state = {items: [], secret:'', connected:false, cached:false, saving:false, active:null, pendingChecks:new Map()};
  const builtInCategories=['의류·침구','수유','수면','위생','목욕','외출','생활·산모','추후 구매'];
  const API = String(window.BABY_PREP_API_URL || '').trim();

  function safeRead(store,key) {
    try { return store.getItem(key) || ''; } catch(e) { return ''; }
  }
  function safeRemove(store,key) {
    try {store.removeItem(key);} catch(e) {}
  }
  function persistSecret(secret) {
    try {
      localStorage.setItem(storageKey,secret);
      if (localStorage.getItem(storageKey) !== secret) throw new Error('SECRET 저장 확인 실패');
      safeRemove(sessionStorage,oldSessionKey);
      return true;
    } catch(e) {
      // Browsers in private mode, or with storage disabled, cannot promise persistence.
      try {sessionStorage.setItem(oldSessionKey,secret);} catch(ignored) {}
      return false;
    }
  }
  function readItemCache() {
    try {
      const cache=JSON.parse(safeRead(localStorage,cacheKey));
      if(cache && cache.api===API && Array.isArray(cache.items) && cache.items.length>0) return cache;
    }catch(e){}
    return null;
  }
  function persistItemCache(items) {
    if(!Array.isArray(items) || !items.length)return;
    try {localStorage.setItem(cacheKey,JSON.stringify({api:API,items,savedAt:Date.now()}));}
    catch(e) {/* Caching is optional; Google Sheets remains the source of truth. */}
  }
  function setTab(view) {
    for(const name of ['list','stats','settings']) {
      const current=name===view;
      $('#'+name+'View').hidden=!current;
      $('#'+name+'Tab').classList.toggle('active',current);
      $('#'+name+'Tab').setAttribute('aria-selected',String(current));
    }
    if(view==='stats')renderStatistics();
  }
  function updateConnectedView() {
    const showList=state.connected||state.cached;
    $('#dashboard').hidden=!showList;
    $('#disconnected').hidden=showList;
    $('#statsDashboard').hidden=!showList;
    $('#statsDisconnected').hidden=showList;
    const hasPersistent=Boolean(safeRead(localStorage,storageKey));
    const hasSaved=hasPersistent||Boolean(safeRead(sessionStorage,oldSessionKey));
    const status=$('#secretStatus');
    status.className='connection-status'+(state.connected?' connected':state.cached?' waiting':'');
    status.textContent=state.connected
      ? `연결됨 · 준비물 ${state.items.length}개 · 자동 연결 ${hasPersistent?'켜짐':'저장 불가(이 세션만)'}`
      : state.cached?'저장된 목록 표시 중 · Google Sheets 연결 확인 전에는 수정할 수 없습니다.'
      : hasSaved?'SECRET이 저장되어 있습니다. 자동 연결을 시도합니다.':'SECRET이 등록되지 않았습니다.';
    $('#forgetSecretBtn').disabled=state.pendingChecks.size>0||(!hasSaved&&!state.connected);
    $('#addItemBtn').disabled=!state.connected||state.saving||state.pendingChecks.size>0;
  }


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
    const categories=[...new Set([...builtInCategories,...state.items.map(i=>i.category)])];
    categories.forEach(cat=>select.add(new Option(cat,cat)));
    if([...select.options].some(o=>o.value===selected))select.value=selected;
    const modal=$('#editCategory'),modalSelected=modal.value;
    modal.replaceChildren();
    categories.forEach(cat=>modal.add(new Option(cat,cat)));
    if([...modal.options].some(o=>o.value===modalSelected))modal.value=modalSelected;
  }
  // v5 statistics: read only from the same state used by the checklist.
  // Render on every state change, including optimistic check/uncheck and cached data.
  function isPrepared(item) {
    return item.status==='구매완료'||item.status==='선물받음';
  }
  function sumOf(items,key) {
    return items.reduce((total,item)=>total+(Number(item[key])||0),0);
  }
  function summarize(items) {
    const done=items.filter(isPrepared).length;
    const remaining=items.filter(item=>!isPrepared(item));
    return {
      total:items.length,
      done,
      rate:items.length?Math.round(done/items.length*100):0,
      estimated:sumOf(items,'estimate'),
      spent:sumOf(items,'price'),
      remaining:sumOf(remaining,'estimate')
    };
  }
  function statEl(tag,cls,text) {
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(text!==undefined)el.textContent=String(text);
    return el;
  }
  function meter(value,label,className='stats-meter') {
    const track=statEl('div',className);
    track.setAttribute('role','img');
    track.setAttribute('aria-label',label);
    const fill=statEl('div');
    fill.style.width=Math.max(0,Math.min(100,value))+'%';
    track.append(fill);
    return track;
  }
  function renderStatistics() {
    const priority=$('#statsPriority').value;
    const scoped=priority?state.items.filter(i=>i.priority===priority):state.items;
    const sum=summarize(scoped);
    $('#statsProgressRate').textContent=sum.rate+'%';
    $('#statsProgressCount').textContent=sum.done+' / '+sum.total+'개 준비 완료';
    $('#statsProgressBar').style.width=sum.rate+'%';
    $('#statsProgressTrack').setAttribute('aria-valuenow',String(sum.rate));
    $('#statsEstimated').textContent=won(sum.estimated);
    $('#statsSpent').textContent=won(sum.spent);
    $('#statsRemaining').textContent=won(sum.remaining);
    $('#statsForecast').textContent=won(sum.spent+sum.remaining);
    const pending=state.pendingChecks.size;
    $('#statsPendingLabel').textContent=pending
      ? pending+'개 항목 저장 중 · 현재 통계는 저장 전 변경 사항을 포함합니다.'
      : '구매완료와 선물받음을 준비 완료로 계산합니다.';
    $('#statsSyncLabel').textContent=state.connected
      ? 'Google Sheets 연결됨'+(pending?' · 저장 중…':'')
      :state.cached?'기기 저장 목록 기준 · 최신 데이터 확인 중':'Google Sheets 연결 필요';
    const cats=[...new Set(scoped.map(i=>i.category||'미분류'))];
    const catRows=$('#statsCategoryRows'), spendRows=$('#statsSpendRows');
    catRows.replaceChildren();spendRows.replaceChildren();
    if(!scoped.length) {
      catRows.append(statEl('p','stats-empty',state.items.length?'선택한 구분에 준비물이 없습니다.':'표시할 준비물이 없습니다.'));
      spendRows.append(statEl('p','stats-empty','지출 내역이 없습니다.'));
    }else{
      for(const cat of cats) {
        const subset=scoped.filter(i=>(i.category||'미분류')===cat);
        const data=summarize(subset);
        const row=statEl('div','stats-category-row');
        const heading=statEl('div','stats-row-head');
        heading.append(statEl('strong','',cat),statEl('span','',data.done+' / '+data.total+'개 · '+data.rate+'%'));
        const amounts=statEl('p','stats-amount-line','예상 '+won(data.estimated)+'  ·  지출 '+won(data.spent));
        row.append(heading,meter(data.rate,cat+' 준비 완료 '+data.rate+'%'),amounts);
        catRows.append(row);
      }
      const spends=cats.map(cat=>({
        cat,amount:sumOf(scoped.filter(i=>(i.category||'미분류')===cat),'price')
      })).sort((a,b)=>b.amount-a.amount);
      if(sum.spent===0) {
        spendRows.append(statEl('p','stats-empty','실제 구매 금액을 입력하면 지출 비중이 표시됩니다.'));
      } else {
        for(const {cat,amount} of spends) {
          if(amount<=0)continue;
          const pct=100*amount/sum.spent;
          const row=statEl('div','stats-spend-row');
          const heading=statEl('div','stats-row-head');
          heading.append(statEl('strong','',cat),statEl('span','',won(amount)+' · '+Math.round(pct)+'%'));
          row.append(heading,meter(pct,cat+' 지출 비중 '+Math.round(pct)+'%','stats-meter spending'));
          spendRows.append(row);
        }
      }
    }
    const priRows=$('#statsPriorityRows');
    priRows.replaceChildren();
    for(const label of ['필수','선택','나중']) {
      const data=summarize(state.items.filter(i=>i.priority===label));
      const row=statEl('div','stats-priority-row');
      const left=statEl('div','stats-priority-left');
      left.append(statEl('strong','',label),statEl('span','',data.done+'/'+data.total+'개 완료'));
      const right=statEl('div','stats-priority-right');
      right.append(statEl('strong','',won(data.spent)),statEl('span','','예상 '+won(data.estimated)));
      row.append(left,right);priRows.append(row);
    }
  }

  function render() {
    const completed=state.items.filter(i=>i.status==='구매완료'||i.status==='선물받음').length;
    $('#progress').textContent=completed+' / '+state.items.length;
    $('#bar').style.width=(state.items.length?100*completed/state.items.length:0)+'%';
    $('#spent').textContent=won(state.items.reduce((v,i)=>v+(Number(i.price)||0),0));
    $('#estimate').textContent='필수 예상 '+won(state.items.filter(i=>i.priority==='필수').reduce((v,i)=>v+(Number(i.estimate)||0),0));
    const q=$('#search').value.trim().toLowerCase(),cat=$('#category').value, priority=$('#priority').value, status=$('#status').value;
    const selected=state.items.filter(i=>(!cat||i.category===cat)&&(!priority||i.priority===priority)&&(!status||i.status===status)&&(!q||(i.name+' '+i.product+' '+i.memo).toLowerCase().includes(q)));
    $('#count').textContent=selected.length+'개 표시';
    const wrap=$('#items');wrap.replaceChildren();
    if (!selected.length) {
      const empty=document.createElement('div');
      empty.className='filter-empty';
      empty.textContent=state.items.length?'선택한 조건에 해당하는 준비물이 없습니다.':'표시할 준비물이 없습니다.';
      wrap.append(empty);
    }
    for(const i of selected){
      const complete=i.status==='구매완료'||i.status==='선물받음';
      const pending=state.pendingChecks.has(i.id);
      const item=document.createElement('article');item.className='item'+(complete?' done':'')+(pending?' pending':'');
      const chk=document.createElement('button');chk.type='button';chk.className='check';chk.textContent=complete?'✓':'';
      chk.setAttribute('aria-label',i.name+(complete?' 완료 해제':' 구매 완료'));
      chk.setAttribute('aria-busy',String(pending));
      chk.disabled=state.saving||!state.connected;
      chk.addEventListener('click',()=>toggleCheck(i.id));
      const info=document.createElement('div');info.className='item-content';
      const title=document.createElement('div');title.className='item-title';title.textContent=i.name;
      const meta=document.createElement('div');meta.className='item-meta';meta.textContent=`${i.category} · ${i.priority} · 권장 ${i.qty}개 · ${i.status}${pending?' · 저장 중…':''}`;
      const price=document.createElement('div');price.className='item-price';price.textContent=`예상 ${won(i.estimate)} · 실제 ${won(i.price)}`;
      info.append(title,meta,price);
      if(i.product || i.memo){const note=document.createElement('div');note.className='item-note';note.textContent=[i.product,i.memo].filter(Boolean).join(' · ');info.append(note);}
      const edit=document.createElement('button');edit.type='button';edit.className='edit';edit.textContent='수정';edit.disabled=state.saving||!state.connected||pending;edit.addEventListener('click',()=>openEditor(i));
      item.append(chk,info,edit);wrap.append(item);
    }
    renderStatistics();
  }
  async function load(showMessage=true) {
    const items=await getItems();
    applyServerItems(items);
    drawCategories();render();
    $('#syncLabel').textContent='Google Sheets 연결됨 · '+new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
    if(showMessage) notify('Google Sheets의 최신 정보를 불러왔습니다.','success');
  }
  async function connect(secret,fromSettings=false) {
    const previousSecret=state.secret,previousConnected=state.connected;
    const button=$('#saveSecretBtn');
    state.secret=secret;
    if(fromSettings) busy(button,true,'연결 확인 중…');
    notify(state.cached?'저장된 준비물을 먼저 표시했습니다. 최신 내용을 확인하는 중…':'저장된 SECRET으로 Google Sheets에 자동 연결하는 중…');
    try {
      await load(false);
      if(state.items.length===0) throw new Error('Google Sheets 준비물 목록이 비어 있습니다. 시트 데이터를 확인하세요.');
      state.connected=true;state.cached=false;
      const isPersistent=persistSecret(secret);
      $('#secretInput').value='';
      $('#secretInput').type='password';
      $('#toggleSecretBtn').textContent='표시';
      $('#toggleSecretBtn').setAttribute('aria-pressed','false');
      updateConnectedView();render();
      if(fromSettings) setTab('list');
      notify(isPersistent?'자동 연결 완료 · 다음 방문부터 SECRET 입력 없이 시작합니다.':'연결 완료 · 브라우저 저장이 차단되어 이번 접속에서만 유지됩니다.',isPersistent?'success':'info');
      return true;
    } catch(err) {
      // A temporary network failure must not erase the user's saved SECRET.
      if(fromSettings && previousConnected){
        state.secret=previousSecret;state.connected=true;
      } else {
        state.secret=fromSettings?previousSecret:secret;
        state.connected=false;
      }
      updateConnectedView();render();
      if(!state.cached&&!state.connected&&!fromSettings)setTab('settings');
      const status=$('#secretStatus');
      if(!state.connected){
        status.className='connection-status error';
        status.textContent=state.cached?'연결 실패 · 저장된 목록만 표시합니다. 새로고침으로 재시도하세요.':'자동 연결 실패 · 저장된 SECRET은 유지됩니다.';
      }
      notify((err.message||'연결에 실패했습니다.')+' · SECRET은 삭제되지 않았습니다.','error');
      return false;
    } finally {
      if(fromSettings) busy(button,false);
    }
  }
  async function sendMutation(action,payload) {
    const bodyText=JSON.stringify(payload),random=nonce(),ts=String(Date.now());
    const sig=await signature('POST',ts,random,action,bodyText);
    const body=new URLSearchParams({action,ts,nonce:random,payload:bodyText,sig});
    // Cross-origin POST responses are opaque; always confirm with a fresh GET.
    await fetch(API,{method:'POST',mode:'no-cors',body,redirect:'follow',cache:'no-store'});
  }
  async function sendSave(id,changes) {
    return sendMutation('save',{id,changes});
  }
  // v4: optimistic checkbox updates. The UI responds immediately; writes and
  // confirmation run asynchronously. One writer per item ensures rapid taps
  // cannot reorder requests on the Apps Script side.
  function applyServerItems(serverItems) {
    state.items=serverItems.map(item=>{
      const pending=state.pendingChecks.get(item.id);
      return pending?{...item,status:pending.desiredStatus}:item;
    });
    // Cache confirmed server values only (not optimistic, unsaved edits).
    persistItemCache(serverItems);
  }
  function toggleCheck(id) {
    if(!state.connected||state.saving)return;
    const item=state.items.find(i=>i.id===id);
    if(!item)return;
    const previous=item.status;
    const next=(previous==='구매완료'||previous==='선물받음')?'미구매':'구매완료';
    let job=state.pendingChecks.get(id);
    if(!job){
      job={desiredStatus:next,confirmedStatus:previous};
      state.pendingChecks.set(id,job);
    }else{
      job.desiredStatus=next;
    }
    // Update first, without waiting for fetch() or a Sheets round trip.
    item.status=next;
    render();
    updateConnectedView();
    if(job.confirmedStatus===previous && job.desiredStatus===next && !job.running){
      job.running=true;
      void flushCheck(id,job);
    }
  }
  async function confirmCheck(id,expected) {
    // Apps Script POST uses no-cors, so the only reliable acknowledgement is
    // a separate, signed GET whose status matches what was written.
    for(const delay of [300,650,1050,1600,2300,3200]) {
      await new Promise(resolve=>setTimeout(resolve,delay));
      const serverItems=await getItems();
      const serverItem=serverItems.find(i=>i.id===id);
      if(serverItem && serverItem.status===expected)return serverItems;
    }
    throw new Error('Google Sheets 저장 결과를 확인하지 못했습니다.');
  }
  async function flushCheck(id,job) {
    try {
      while(state.pendingChecks.get(id)===job) {
        const target=job.desiredStatus;
        // POST may succeed even when the browser cannot read its response.
        let postError=null;
        try {await sendSave(id,{구매상태:target});}
        catch(err){postError=err;}
        let serverItems;
        try {serverItems=await confirmCheck(id,target);}
        catch(err) {throw postError||err;}
        job.confirmedStatus=target;
        // Clear the pending marker only once the latest tap is confirmed.
        if(job.desiredStatus===target)state.pendingChecks.delete(id);
        applyServerItems(serverItems);
        drawCategories();render();updateConnectedView();
        if(job.desiredStatus===target){
          notify('체크 변경이 Google Sheets에 저장되었습니다.','success');
          return;
        }
        // A second tap happened during the request: write that newer choice.
      }
    }catch(err){
      if(state.pendingChecks.get(id)!==job)return;
      state.pendingChecks.delete(id);
      try {
        const serverItems=await getItems();
        applyServerItems(serverItems);
      }catch(e){
        const current=state.items.find(i=>i.id===id);
        if(current)current.status=job.confirmedStatus;
      }
      drawCategories();render();updateConnectedView();
      notify('체크 변경을 저장하지 못해 서버의 마지막 확인 상태로 복원했습니다. '+(err.message||''),'error');
    }
  }
  function fillEditor(i) {
    $('#editName').value=i.name||'';
    $('#editCategory').value=i.category||builtInCategories[0];
    $('#editPriority').value=i.priority||'필수';
    $('#editQty').value=i.qty||1;
    $('#editEstimate').value=Number(i.estimate||0);
    $('#editStatus').value=i.status||'미구매';
    $('#editPrice').value=Number(i.price||0);
    $('#editProduct').value=i.product||'';
    $('#editMemo').value=i.memo||'';
    $('#editorStatus').hidden=true;
    $('#editorStatus').textContent='';
  }
  function openEditor(i) {
    state.active=i.id;
    $('#editTitle').textContent='준비물 수정';
    fillEditor(i);
    $('#deleteItemBtn').hidden=false;
    $('#saveBtn').textContent='변경사항 저장';
    $('#editor').showModal();
  }
  function openAddEditor() {
    if(!state.connected||state.saving||state.pendingChecks.size)return;
    state.active=null;
    $('#editTitle').textContent='준비물 추가';
    fillEditor({category:$('#category').value||builtInCategories[0],priority:$('#priority').value||'필수',qty:1,estimate:0,status:'미구매',price:0});
    $('#deleteItemBtn').hidden=true;
    $('#saveBtn').textContent='새 준비물 저장';
    $('#editor').showModal();
  }
  function formRecord() {
    const qty=Number($('#editQty').value),estimate=Number($('#editEstimate').value),price=Number($('#editPrice').value||0);
    if(!Number.isSafeInteger(qty)||qty<1||qty>9999)throw new Error('권장 수량은 1~9999개 사이로 입력하세요.');
    if(!Number.isSafeInteger(estimate)||estimate<0||estimate>100000000)throw new Error('예상 금액을 확인하세요.');
    if(!Number.isSafeInteger(price)||price<0||price>100000000)throw new Error('실제 구매 금액을 확인하세요.');
    const name=$('#editName').value.trim();
    if(!name||name.length>80)throw new Error('품목명을 80자 이내로 입력하세요.');
    return {name,category:$('#editCategory').value,priority:$('#editPriority').value,qty,estimate,status:$('#editStatus').value,price,product:$('#editProduct').value,memo:$('#editMemo').value};
  }
  function verifyItem(id,item) {
    const actual=state.items.find(i=>i.id===id);
    if(!actual)return false;
    return ['name','category','priority','qty','estimate','status','price','product','memo']
      .every(key=>String(actual[key])===String(item[key]));
  }
  function freshId() {
    return 'BABY-'+Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  async function persistItem(action,id,item) {
    if(state.saving)return false;
    if(state.pendingChecks.size){notify('체크 저장이 끝난 뒤 준비물을 수정해 주세요.','info');return false;}
    state.saving=true;render();notify('Google Sheets에 저장 중입니다.');
    let networkError;
    try{await sendMutation(action,action==='delete'?{id}:{id,item});}catch(err){networkError=err;}
    try{
      let confirmed=false;
      for(const pause of [400,800,1400,2200]) {
        await new Promise(resolve=>setTimeout(resolve,pause));
        await load(false);
        confirmed=action==='delete'?!state.items.some(i=>i.id===id):verifyItem(id,item);
        if(confirmed)break;
      }
      if(!confirmed)throw new Error(networkError?'네트워크 오류로 저장을 확인하지 못했습니다.':'변경 사항이 반영되지 않았습니다. Apps Script를 v2 코드로 바꾸고 새 버전으로 배포했는지 확인하세요.');
      notify(action==='add'?'준비물을 추가했습니다.':action==='delete'?'삭제 완료! 원본은 스프레드시트 삭제보관 시트에 보관됩니다.':'준비물 수정 완료!','success');
      return true;
    }catch(err){notify(err.message||'저장 오류','error');return false;}
    finally{state.saving=false;render();}
  }
  $('#listTab').addEventListener('click',()=>setTab('list'));
  $('#statsTab').addEventListener('click',()=>setTab('stats'));
  $('#settingsTab').addEventListener('click',()=>setTab('settings'));
  $('#goSettingsBtn').addEventListener('click',()=>setTab('settings'));
  $('#statsGoSettingsBtn').addEventListener('click',()=>setTab('settings'));
  $('#statsPriority').addEventListener('change',renderStatistics);
  $('#statsRefreshBtn').addEventListener('click',()=>$('#refreshBtn').click());
  $('#settingsForm').addEventListener('submit',e=>{
    e.preventDefault();
    const secret=$('#secretInput').value;
    if(secret.length<16){notify('SECRET은 16자 이상 입력하세요.','error');return;}
    connect(secret,true);
  });
  $('#toggleSecretBtn').addEventListener('click',()=>{
    const input=$('#secretInput'),show=input.type==='password';
    input.type=show?'text':'password';
    $('#toggleSecretBtn').textContent=show?'숨기기':'표시';
    $('#toggleSecretBtn').setAttribute('aria-pressed',String(show));
  });
  $('#forgetSecretBtn').addEventListener('click',()=>{
    safeRemove(localStorage,storageKey);
    safeRemove(localStorage,cacheKey);
    safeRemove(sessionStorage,oldSessionKey);
    state.secret='';state.items=[];state.connected=false;state.cached=false;state.pendingChecks.clear();
    $('#secretInput').value='';
    updateConnectedView();render();setTab('settings');
    notify('이 기기에 저장된 SECRET을 삭제하고 연결을 해제했습니다.','success');
  });
  $('#refreshBtn').addEventListener('click',async()=>{
    if(state.saving)return;const button=$('#refreshBtn');busy(button,true,'불러오는 중…');
    try {
      if(!state.connected) {
        if(!state.secret){setTab('settings');notify('설정에서 SECRET을 입력하세요.','info');}
        else await connect(state.secret,false);
      } else await load();
    }catch(e){notify(e.message,'error');}
    finally{busy(button,false);}
  });
  $('#addItemBtn').addEventListener('click',openAddEditor);
  $('#cancelBtn').addEventListener('click',()=>$('#editor').close());
  $('#editForm').addEventListener('submit',async e=>{
    e.preventDefault();if(state.saving)return;
    let item;
    try{item=formRecord();}catch(err){notify(err.message,'error');return;}
    const adding=!state.active;
    const id=adding?freshId():state.active;
    busy($('#saveBtn'),true,'저장하는 중…');
    try { if(await persistItem(adding?'add':'edit',id,item)) $('#editor').close(); }
    finally{busy($('#saveBtn'),false);}
  });
  $('#deleteItemBtn').addEventListener('click',async()=>{
    const id=state.active;
    if(!id||state.saving)return;
    const item=state.items.find(i=>i.id===id);
    if(!item)return;
    if(!window.confirm(`「${item.name}」 준비물을 삭제할까요?\n삭제한 항목은 Google Sheets의 '삭제보관' 시트에 보관됩니다.`))return;
    busy($('#deleteItemBtn'),true,'삭제하는 중…');
    try { if(await persistItem('delete',id,null)) $('#editor').close(); }
    finally{busy($('#deleteItemBtn'),false);}
  });
  for(const id of ['search','category','priority','status'])$('#'+id).addEventListener(id==='search'?'input':'change',render);
  updateConnectedView();
  const savedSecret=safeRead(localStorage,storageKey)||safeRead(sessionStorage,oldSessionKey);
  if(savedSecret) {
    state.secret=savedSecret;
    // Show saved results immediately; verify with the server in the background.
    const old=readItemCache();
    if(old){
      state.items=old.items;state.cached=true;
      drawCategories();render();
      $('#syncLabel').textContent='기기 저장 목록 · 최신 정보 확인 중…';
      updateConnectedView();
    }
    connect(savedSecret,false);
  } else if (!API) {
    notify('config.js에 Apps Script 배포 URL이 없습니다. 설정을 확인하세요.','error');
  }
})();
