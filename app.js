/* GitHub Pages UI. SECRET is entered by the user, never hardcoded in repository. */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const won = n => Number(n || 0).toLocaleString('ko-KR') + '원';
  // Keep the API URL in config.js, and store the user's SECRET only on this device.
  const storageKey = 'bp-device-secret-v2';
  const oldSessionKey = 'bp-active-secret-v1';
  const cacheKey = 'bp-items-cache-v3';
  const journalKey = 'bp-pending-edits-v9'; // retain v9 queue across updates
  const categoryExpandKey='bp-expanded-categories-v10';
  const state = {items: [], secret:'', connected:false, cached:false, active:null, pendingChecks:new Map(),
    pendingEdits:new Map(), mutationQueue:[], mutationBusy:false, mutationFailed:false, expanded:new Map(), drag:null};
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
    document.body.dataset.view=view;
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
    $('#forgetSecretBtn').disabled=state.pendingChecks.size>0||state.pendingEdits.size>0||(!hasSaved&&!state.connected);
    $('#addItemBtn').disabled=!state.connected;
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
      priority:String(r['우선순위']||''),purchaseQty:Number(r['구매수량']||0),
      status:String(r['구매상태']==='선물받음'?'구매완료':r['구매상태']||'미구매'),price:Number(r['실제금액']||0),
      product:String(r['구매제품']||''),memo:String(r['메모']||''),updated:String(r['수정일시']||''),order:Number(r['정렬순서']||0),
      carrot:r['당근마켓']===true||String(r['당근마켓']).toUpperCase()==='TRUE'
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
    return item.status==='구매완료';
  }
  function sumOf(items,key) {
    return items.reduce((total,item)=>total+(Number(item[key])||0),0);
  }
  function summarize(items) {
    const done=items.filter(isPrepared).length;
    return {
      total:items.length,
      done,
      rate:items.length?Math.round(done/items.length*100):0,
      spent:sumOf(items,'price'),
      purchaseQty:sumOf(items,'purchaseQty'),
      remaining:items.length-done
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
    $('#statsProgressTrack').style.setProperty('--rate',sum.rate+'%');
    $('#statsProgressTrack').setAttribute('aria-valuenow',String(sum.rate));
    $('#statsSpent').textContent=won(sum.spent);
    $('#statsPurchasedQty').textContent=sum.purchaseQty.toLocaleString('ko-KR')+'개';
    $('#statsPurchasedItems').textContent=sum.done+'개';
    $('#statsRemainingItems').textContent=sum.remaining+'개';
    const pending=state.pendingChecks.size+state.pendingEdits.size;
    $('#statsPendingLabel').textContent=pending
      ? pending+'개 항목 저장 대기/진행 중 · 표시된 통계는 아직 서버에 저장되지 않은 변경을 포함합니다.'
      : '구매완료를 준비 완료로 계산합니다.';
    $('#statsSyncLabel').textContent=state.connected
      ? 'Google Sheets 연결됨'+(pending?' · '+pending+'건 저장 대기/진행 중':'')
      :state.cached?'기기 저장 목록 기준 · 최신 데이터 확인 중':'Google Sheets 연결 필요';
    const cats=[...new Set(scoped.map(i=>i.category||'미분류'))];
    const catRows=$('#statsCategoryRows'),spendRows=$('#statsSpendRows');
    catRows.replaceChildren();spendRows.replaceChildren();
    if(!scoped.length){
      catRows.append(statEl('p','stats-empty',state.items.length?'선택한 구분에 준비물이 없습니다.':'표시할 준비물이 없습니다.'));
      spendRows.append(statEl('p','stats-empty','구매 내역이 없습니다.'));
    }else{
      for(const cat of cats){
        const subset=scoped.filter(i=>(i.category||'미분류')===cat);
        const data=summarize(subset);
        const row=statEl('div','stats-category-row');
        const heading=statEl('div','stats-row-head');
        heading.append(categoryIcon(cat),statEl('strong','',cat),statEl('span','',data.done+' / '+data.total+'개 · '+data.rate+'%'));
        const amounts=statEl('p','stats-amount-line','구매 금액 '+won(data.spent)+'  ·  구매 수량 '+data.purchaseQty+'개');
        row.append(heading,meter(data.rate,cat+' 준비 완료 '+data.rate+'%'),amounts);
        catRows.append(row);
      }
      const spends=cats.map(cat=>({cat,amount:sumOf(scoped.filter(i=>(i.category||'미분류')===cat),'price')}))
        .sort((a,b)=>b.amount-a.amount);
      if(sum.spent===0){
        spendRows.append(statEl('p','stats-empty','구매 금액을 입력하면 지출 비중이 표시됩니다.'));
      }else{
        for(const {cat,amount} of spends){
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
    for(const label of ['필수','선택','나중']){
      const data=summarize(state.items.filter(i=>i.priority===label));
      const row=statEl('div','stats-priority-row');
      const left=statEl('div','stats-priority-left');
      left.append(statEl('strong','',label),statEl('span','',data.done+'/'+data.total+'개 완료'));
      const right=statEl('div','stats-priority-right');
      right.append(statEl('strong','',won(data.spent)),statEl('span','','구매 수량 '+data.purchaseQty+'개'));
      row.append(left,right);priRows.append(row);
    }
  }

  function compareItems(a,b) {
    const ao=Number(a.order),bo=Number(b.order);
    const x=Number.isFinite(ao)&&ao>0?ao:Number.MAX_SAFE_INTEGER;
    const y=Number.isFinite(bo)&&bo>0?bo:Number.MAX_SAFE_INTEGER;
    return x-y || a.name.localeCompare(b.name,'ko');
  }
  function categoryNames(items) {
    const all=[...new Set(items.map(i=>i.category||'미분류'))];
    return all.sort((a,b)=>{
      const ia=builtInCategories.indexOf(a),ib=builtInCategories.indexOf(b);
      if(ia<0&&ib<0)return a.localeCompare(b,'ko');
      return (ia<0?999:ia)-(ib<0?999:ib);
    });
  }
  function categoryExpanded(cat,first,filtersActive) {
    if(state.expanded.has(cat))return state.expanded.get(cat);
    // Open the first group initially; when filtering, open results for convenience.
    // Match the compact card view in v16; stored expansion preferences still win.
    return filtersActive;
  }
  function saveExpanded() {
    try {localStorage.setItem(categoryExpandKey,JSON.stringify([...state.expanded.entries()]));}catch(e){}
  }
  function setExpanded(cat,expanded) {
    state.expanded.set(cat,expanded);saveExpanded();render();
  }
  const categoryIcons = {
    '의류·침구': ['shirt','coral'], '수유':['bottle','honey'],
    '수면':['bed','sage'], '수면·생활':['bed','sage'],
    '위생':['sparkle','lavender'], '목욕':['bath','lavender'],
    '외출':['stroller','sky'], '생활·산모':['heart','coral'],
    '추후 구매':['clock','honey']
  };
  const iconSvgPaths = {
    shirt:'<path d="m8 4 4 2 4-2 5 4-3 4-2-2v11H8V10l-2 2-3-4 5-4Z"/>',
    bottle:'<path d="M9 3h6v3H9zM10 6v3l-3 3v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-8l-3-3V6M9 15h6M9 19h6"/>',
    bed:'<path d="M3 7v14M21 7v14M3 18h18M5 10h14v8H5zM7 10V7h4v3m2 0V7h4v3"/>',
    sparkle:'<path d="m12 2 2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2L12 2Z"/>',
    bath:'<path d="M3 13h18l-2 7H5l-2-7ZM7 13V8a3 3 0 0 1 6 0M6 21v1M18 21v1"/>',
    stroller:'<path d="M4 5h7l4 10H6a5 5 0 0 1-2-4V5ZM15 15h6M7 15l-2 3h14M8 21a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM18 21a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>',
    heart:'<path d="M20 9c0 4-8 11-8 11S4 13 4 9a4 4 0 0 1 8-2 4 4 0 0 1 8 2Z"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  };
  function categoryIcon(name) {
    const [shape,tone]=categoryIcons[name]||['heart','coral'];
    const outer=statEl('span','category-icon tone-'+tone);
    outer.setAttribute('aria-hidden','true');
    outer.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">'+iconSvgPaths[shape]+'</svg>';
    return outer;
  }
  function buildItem(i,allowDrag) {
    const complete=isPrepared(i);
    const pending=state.pendingChecks.has(i.id)||state.pendingEdits.has(i.id);
    const item=document.createElement('article');
    item.className='item'+(complete?' done':'')+(pending?' pending':'');
    item.dataset.itemId=i.id;
    const chk=document.createElement('button');chk.type='button';chk.className='check';chk.textContent=complete?'✓':'';
    chk.setAttribute('aria-label',i.name+(complete?' 완료 해제':' 구매 완료'));
    chk.setAttribute('aria-busy',String(pending));
    chk.disabled=state.pendingEdits.has(i.id)||!state.connected;
    chk.addEventListener('click',()=>toggleCheck(i.id));
    const info=document.createElement('div');info.className='item-content';
    const title=document.createElement('div');title.className='item-title';title.textContent=i.name;
    const titleRow=document.createElement('div');titleRow.className='item-name-row';titleRow.append(title);
    if(i.carrot){
      const badge=document.createElement('span');badge.className='carrot-badge';badge.textContent='🥕 당근 예정';
      badge.setAttribute('aria-label','당근마켓 이용 예정');
      titleRow.append(badge);
    }
    const meta=document.createElement('div');meta.className='item-meta';meta.textContent=`${i.priority} · ${i.status}${pending?' · 저장 중…':''}`;
    const price=document.createElement('div');price.className='item-price';price.textContent=`구매 금액 ${won(i.price)} · 구매 수량 ${i.purchaseQty||0}개`;
    info.append(titleRow,meta,price);
    if(i.product||i.memo){const note=document.createElement('div');note.className='item-note';note.textContent=[i.product,i.memo].filter(Boolean).join(' · ');info.append(note);}
    const edit=document.createElement('button');edit.type='button';edit.className='edit';edit.textContent='수정';edit.disabled=!state.connected||pending;edit.addEventListener('click',()=>openEditor(i));
    const grip=document.createElement('button');grip.type='button';grip.className='drag-handle';grip.textContent='⠿';
    grip.setAttribute('aria-label',i.name+' 순서 이동');grip.title='손으로 끌어 순서 바꾸기';
    grip.disabled=!allowDrag;
    grip.addEventListener('pointerdown',e=>beginDrag(e,item,i.category));
    // Keyboard access: move within the category using Alt+Up/Down.
    grip.addEventListener('keydown',e=>{
      if(!allowDrag||!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key))return;
      e.preventDefault();
      const container=item.parentElement;
      const list=[...container.querySelectorAll(':scope > .item')];
      const index=list.indexOf(item),to=index+(e.key==='ArrowUp'?-1:1);
      if(to<0||to>=list.length)return;
      const ids=list.map(node=>node.dataset.itemId);
      [ids[index],ids[to]]=[ids[to],ids[index]];
      queueReorder(i.category,ids);
    });
    item.append(chk,info,edit,grip);
    return item;
  }
  function render() {
    const completed=state.items.filter(isPrepared).length;
    $('#progress').textContent=completed+' / '+state.items.length;
    $('#progressRate').textContent=(state.items.length?Math.round(100*completed/state.items.length):0)+'%';
    $('#completedCount').textContent=completed+'개';
    $('#remainingCount').textContent=(state.items.length-completed)+'개';
    $('#bar').style.width=(state.items.length?100*completed/state.items.length:0)+'%';
    $('#spent').textContent=won(state.items.reduce((v,i)=>v+(Number(i.price)||0),0));
    $('#purchaseQtyTotal').textContent='구매 수량 '+sumOf(state.items,'purchaseQty').toLocaleString('ko-KR')+'개';
    const q=$('#search').value.trim().toLowerCase(),cat=$('#category').value,priority=$('#priority').value,status=$('#status').value;
    const filtersActive=!!(q||priority||status);
    const selected=state.items.filter(i=>(!cat||i.category===cat)&&(!priority||i.priority===priority)&&(!status||i.status===status)&&(!q||(i.name+' '+i.product+' '+i.memo).toLowerCase().includes(q)));
    $('#count').textContent=selected.length+'개 표시';
    const wrap=$('#items');wrap.replaceChildren();
    const allowDrag=state.connected&&!filtersActive;
    $('#dragHint').textContent=filtersActive
      ? '드래그 순서 변경은 검색어·구분·상태 필터를 해제하면 가능합니다.'
      : '⠿ 손잡이를 끌어 같은 카테고리 안에서 순서를 변경하세요.';
    if(!selected.length){
      const empty=document.createElement('div');empty.className='filter-empty';
      empty.textContent=state.items.length?'선택한 조건에 해당하는 준비물이 없습니다.':'표시할 준비물이 없습니다.';
      wrap.append(empty);
    }
    const cats=categoryNames(selected);
    for(let ci=0;ci<cats.length;ci++){
      const category=cats[ci];
      const subset=selected.filter(i=>(i.category||'미분류')===category).sort(compareItems);
      const done=subset.filter(isPrepared).length;
      const section=document.createElement('section');section.className='category-group';
      const opened=categoryExpanded(category,ci===0,filtersActive);
      if(opened)section.classList.add('expanded');
      const heading=document.createElement('button');heading.type='button';heading.className='category-heading';
      heading.setAttribute('aria-expanded',String(opened));
      heading.append(categoryIcon(category),statEl('strong','category-name',category),statEl('span','category-count',`${done}/${subset.length} 준비완료`),statEl('span','category-arrow','▾'));
      heading.addEventListener('click',()=>setExpanded(category,!categoryExpanded(category,ci===0,filtersActive)));
      const list=document.createElement('div');list.className='category-list';list.dataset.category=category;list.hidden=!opened;
      for(const i of subset)list.append(buildItem(i,allowDrag));
      section.append(heading,list);wrap.append(section);
    }
    renderStatistics();
  }
  function queueReorder(category,ids) {
    if(!state.connected)return false;
    const expected=state.items.filter(i=>i.category===category).sort(compareItems).map(i=>i.id);
    if(ids.length!==expected.length || new Set(ids).size!==ids.length || ids.some(id=>!expected.includes(id))){
      notify('필터가 적용된 상태에서는 순서를 바꿀 수 없습니다. 새로고침 후 다시 시도하세요.','error');return false;
    }
    if(expected.every((id,idx)=>id===ids[idx]))return true;
    const job={action:'reorder',id:'ORDER-'+nonce().slice(0,16).toUpperCase(),item:{category,ids:[...ids]}};
    state.mutationQueue.push(job);
    state.pendingEdits.set(job.id,job);
    saveJournal();
    applyOrder(state.items,category,ids);
    render();updateConnectedView();updateQueueView();
    notify('순서를 먼저 바꿨습니다. Google Sheets에 저장 중…','info');
    void drainMutationQueue();
    return true;
  }
  function applyOrder(items,category,ids) {
    const byId=new Map(items.filter(i=>i.category===category).map(i=>[i.id,i]));
    ids.forEach((id,index)=>{const it=byId.get(id);if(it)it.order=index+1;});
  }
  function beginDrag(e,item,category) {
    if(e.pointerType==='mouse'&&e.button!==0)return;
    if(!state.connected||state.drag)return;
    const list=item.parentElement;
    if(!list||list.hidden)return;
    e.preventDefault();
    const rect=item.getBoundingClientRect();
    const drag={pointerId:e.pointerId,item,list,category,startY:e.clientY,startX:e.clientX,
      offsetY:e.clientY-rect.top,offsetX:e.clientX-rect.left,width:rect.width,left:rect.left,active:false,ghost:null};
    state.drag=drag;
    const move=ev=>{
      if(ev.pointerId!==drag.pointerId)return;
      if(!drag.active&&Math.hypot(ev.clientX-drag.startX,ev.clientY-drag.startY)<5)return;
      if(!drag.active){
        drag.active=true;
        item.classList.add('drag-source');
        drag.ghost=item.cloneNode(true);drag.ghost.classList.remove('drag-source');
        drag.ghost.classList.add('drag-ghost');drag.ghost.style.width=drag.width+'px';
        document.body.append(drag.ghost);
      }
      ev.preventDefault();
      drag.ghost.style.top=(ev.clientY-drag.offsetY)+'px';
      drag.ghost.style.left=drag.left+'px';
      const siblings=[...list.querySelectorAll(':scope > .item')].filter(node=>node!==item);
      const before=siblings.find(node=>ev.clientY<node.getBoundingClientRect().top+node.getBoundingClientRect().height/2);
      if(before)list.insertBefore(item,before);else list.append(item);
      if(ev.clientY>window.innerHeight-65)window.scrollBy(0,14);
      else if(ev.clientY<70)window.scrollBy(0,-14);
    };
    const finish=ev=>{
      if(ev.pointerId!==drag.pointerId)return;
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerup',finish);
      window.removeEventListener('pointercancel',finish);
      if(drag.ghost)drag.ghost.remove();
      item.classList.remove('drag-source');
      state.drag=null;
      if(ev.type==='pointercancel'){render();return;}
      if(drag.active){
        const ids=[...list.querySelectorAll(':scope > .item')].map(node=>node.dataset.itemId);
        if(!queueReorder(category,ids))render();
      }
    };
    window.addEventListener('pointermove',move,{passive:false});
    window.addEventListener('pointerup',finish);
    window.addEventListener('pointercancel',finish);
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
    // Keep routine startup reconnection silent; show connection feedback only for manual settings changes.
    if(fromSettings) notify('Google Sheets 연결 확인 중…');
    else clearNotice();
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
      if(state.mutationQueue.length) void drainMutationQueue();
      if(fromSettings) {
        notify(isPersistent?'SECRET 저장 및 연결 완료 · 다음 방문부터 자동 연결됩니다.':'연결 완료 · 브라우저 저장이 차단되어 이번 접속에서만 유지됩니다.',isPersistent?'success':'info');
      } else {
        // Silent success on page load; errors and save status remain visible.
        clearNotice();
      }
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
    const merged=serverItems.map(item=>({...item}));
    for(const job of state.mutationQueue){
      const at=merged.findIndex(item=>item.id===job.id);
      if(job.action==='reorder'){applyOrder(merged,job.item.category,job.item.ids);continue;}
      if(job.action==='delete'){if(at!==-1)merged.splice(at,1);}
      else if(at!==-1)merged[at]={...merged[at],...job.item,id:job.id};
      else merged.push({...job.item,id:job.id});
    }
    state.items=merged.map(item=>{
      const pending=state.pendingChecks.get(item.id);
      return pending?{...item,status:pending.desiredStatus}:item;
    });
    // Cache only verified Sheets values; queued edits live in a separate local journal.
    persistItemCache(serverItems);
  }
  function toggleCheck(id) {
    if(!state.connected||state.pendingEdits.has(id))return;
    const item=state.items.find(i=>i.id===id);
    if(!item)return;
    const previous=item.status;
    const next=previous==='구매완료'?'미구매':'구매완료';
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
    $('#editPurchaseQty').value=Number(i.purchaseQty||0);
    $('#editStatus').value=i.status||'미구매';
    $('#editPrice').value=Number(i.price||0);
    $('#editCarrot').checked=i.carrot===true;
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
    if(!state.connected)return;
    state.active=null;
    $('#editTitle').textContent='준비물 추가';
    fillEditor({category:$('#category').value||builtInCategories[0],priority:$('#priority').value||'필수',purchaseQty:0,status:'미구매',price:0});
    $('#deleteItemBtn').hidden=true;
    $('#saveBtn').textContent='새 준비물 저장';
    $('#editor').showModal();
  }
  function formRecord() {
    const purchaseQty=Number($('#editPurchaseQty').value||0);
    const price=Number($('#editPrice').value||0);
    if(!Number.isSafeInteger(purchaseQty)||purchaseQty<0||purchaseQty>9999)throw new Error('구매 수량은 0~9999개 사이로 입력하세요.');
    if(!Number.isSafeInteger(price)||price<0||price>100000000)throw new Error('구매 금액을 확인하세요.');
    const name=$('#editName').value.trim();
    if(!name||name.length>80)throw new Error('품목명을 80자 이내로 입력하세요.');
    return {name,category:$('#editCategory').value,priority:$('#editPriority').value,
      purchaseQty,status:$('#editStatus').value,price,product:$('#editProduct').value,memo:$('#editMemo').value,
      carrot:$('#editCarrot').checked};
  }
  function matchesItem(serverItems,job) {
    const actual=serverItems.find(i=>i.id===job.id);
    if(job.action==='reorder'){
      const ids=serverItems.filter(i=>i.category===job.item.category).sort(compareItems).map(i=>i.id);
      return ids.length===job.item.ids.length&&ids.every((id,at)=>id===job.item.ids[at]);
    }
    if(job.action==='delete')return !actual;
    if(!actual)return false;
    const keys=['name','category','priority','purchaseQty','status','price','product','memo'];
    // Old queued v16 edits did not contain the new checkbox.
    if(typeof job.item.carrot==='boolean')keys.push('carrot');
    return keys.every(key=>String(actual[key])===String(job.item[key]));
  }
  function freshId() {
    return 'BABY-'+Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  // A local journal keeps unconfirmed edits if the user closes the home-screen app
  // before Google Sheets has finished responding. It never contains the SECRET.
  function saveJournal() {
    try {
      if(!state.mutationQueue.length){localStorage.removeItem(journalKey);return true;}
      localStorage.setItem(journalKey,JSON.stringify({api:API,jobs:state.mutationQueue}));
      return !!localStorage.getItem(journalKey);
    }catch(e){return false;}
  }
  function restoreJournal() {
    try {
      const saved=JSON.parse(localStorage.getItem(journalKey)||'null');
      if(!saved || saved.api!==API || !Array.isArray(saved.jobs))return;
      for(const job of saved.jobs.slice(0,50)) {
        if(!job || !['edit','add','delete','reorder'].includes(job.action))continue;
        const isOrder=job.action==='reorder';
        if(isOrder) {
          if(!/^ORDER-[A-F0-9]{16}$/.test(String(job.id||'')) || !job.item ||
            !builtInCategories.includes(job.item.category) || !Array.isArray(job.item.ids) ||
            job.item.ids.length>500 || job.item.ids.some(id=>!/^BABY-(?:\d{3}|[A-F0-9]{16})$/.test(String(id))))continue;
        } else if(!/^BABY-(?:\d{3}|[A-F0-9]{16})$/.test(String(job.id||'')) ||
            (job.action!=='delete' && (!job.item || typeof job.item!=='object')))continue;
        if(state.pendingEdits.has(job.id))continue;
        const entry={action:job.action,id:job.id,item:job.item||null};
        state.mutationQueue.push(entry);
        state.pendingEdits.set(entry.id,entry);
      }
    }catch(e){}
  }
  function updateQueueView() {
    const count=state.mutationQueue.length;
    const panel=$('#saveQueueBanner');panel.hidden=count===0;
    const text=$('#saveQueueText');
    text.textContent=state.mutationFailed
      ? count+'건의 변경을 Google Sheets에 확인하지 못했습니다. 재시도해 주세요.'
      : count+'건의 변경을 Google Sheets에 저장 중…';
    $('#retrySaveBtn').hidden=!state.mutationFailed;
    if(panel.hidden)return;
    panel.classList.toggle('save-failed',state.mutationFailed);
  }
  function optimisticMutation(action,id,item) {
    const previous=state.items.find(row=>row.id===id);
    if(action==='delete')state.items=state.items.filter(row=>row.id!==id);
    else if(action==='add'){
      const max=Math.max(0,...state.items.filter(x=>x.category===item.category).map(x=>Number(x.order)||0));
      state.items.push({...item,id,order:max+1});
    }else state.items=state.items.map(row=>{
      if(row.id!==id)return row;
      const changedCategory=row.category!==item.category;
      const max=Math.max(0,...state.items.filter(x=>x.category===item.category).map(x=>Number(x.order)||0));
      return {...row,...item,order:changedCategory?max+1:row.order};
    });
  }
  // Apply immediately; enqueue network writes and verification asynchronously.
  function queueMutation(action,id,item) {
    if(!state.connected){notify('연결을 확인한 뒤 다시 시도해 주세요.','error');return false;}
    if(state.pendingChecks.has(id)||state.pendingEdits.has(id)) {
      notify('이 품목은 이전 변경사항 저장 중입니다. 잠시 뒤 다시 시도해 주세요.','info');return false;
    }
    const job={action,id,item:item?{...item}:null};
    state.mutationQueue.push(job);state.pendingEdits.set(id,job);
    const journalOk=saveJournal();
    optimisticMutation(action,id,item);
    drawCategories();render();updateConnectedView();updateQueueView();
    notify(journalOk?'화면에 먼저 반영했습니다. Google Sheets 저장을 확인 중입니다.':'화면에 먼저 반영했습니다. 이 기기에 저장 대기 내역을 보관하지 못했으므로 확인 완료 전 앱을 닫지 마세요.','info');
    void drainMutationQueue();
    return true;
  }
  async function confirmMutation(job) {
    for(const pause of [250,500,900,1400,2200,3200,4500]) {
      await new Promise(resolve=>setTimeout(resolve,pause));
      const serverItems=await getItems();
      if(matchesItem(serverItems,job))return serverItems;
    }
    throw new Error('서버에서 변경 내용을 아직 확인하지 못했습니다.');
  }
  async function drainMutationQueue() {
    if(!state.connected||state.mutationBusy||!state.mutationQueue.length)return;
    state.mutationBusy=true;state.mutationFailed=false;updateQueueView();
    try {
      while(state.connected && state.mutationQueue.length){
        const job=state.mutationQueue[0];
        let serverItems;
        // After an interrupted request, check whether the write succeeded before
        // replaying it (safe for create/delete as well as edits).
        try {
          const current=await getItems();
          if(matchesItem(current,job))serverItems=current;
        }catch(ignored){}
        if(!serverItems){
          let postError=null;
          try {await sendMutation(job.action,job.action==='delete'?{id:job.id}:job.action==='reorder'?job.item:{id:job.id,item:job.item});}
          catch(e){postError=e;}
          try {serverItems=await confirmMutation(job);}
          catch(e){throw postError||e;}
        }
        // Remote state is authoritative after verification; keep later queued edits.
        state.mutationQueue.shift();state.pendingEdits.delete(job.id);
        saveJournal();
        applyServerItems(serverItems);
        drawCategories();render();updateConnectedView();updateQueueView();
      }
      if(!state.mutationQueue.length)notify('변경사항이 Google Sheets에 모두 저장됐습니다.','success');
    }catch(e){
      state.mutationFailed=true;
      notify('아직 서버 저장을 확인하지 못했습니다. 저장 대기 내역은 이 기기에 보관됩니다. 재시도해 주세요. '+(e.message||''),'error');
      updateQueueView();
    }finally{
      state.mutationBusy=false;
      updateQueueView();
    }
  }
  $('#expandAllBtn').addEventListener('click',()=>{for(const cat of categoryNames(state.items))state.expanded.set(cat,true);saveExpanded();render();});
  $('#collapseAllBtn').addEventListener('click',()=>{for(const cat of categoryNames(state.items))state.expanded.set(cat,false);saveExpanded();render();});
  $('#listTab').addEventListener('click',()=>setTab('list'));
  $('#statsTab').addEventListener('click',()=>setTab('stats'));
  $('#settingsTab').addEventListener('click',()=>setTab('settings'));
  $('#goSettingsBtn').addEventListener('click',()=>setTab('settings'));
  $('#statsGoSettingsBtn').addEventListener('click',()=>setTab('settings'));
  $('#statsPriority').addEventListener('change',renderStatistics);
  $('#statsRefreshBtn').addEventListener('click',()=>$('#refreshBtn').click());
  $('#retrySaveBtn').addEventListener('click',()=>{void drainMutationQueue();});
  window.addEventListener('online',()=>{if(state.mutationQueue.length)void drainMutationQueue();});
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
    safeRemove(localStorage,journalKey);
    state.secret='';state.items=[];state.connected=false;state.cached=false;state.pendingChecks.clear();
    state.pendingEdits.clear();state.mutationQueue=[];state.mutationFailed=false;updateQueueView();
    $('#secretInput').value='';
    updateConnectedView();render();setTab('settings');
    notify('이 기기에 저장된 SECRET을 삭제하고 연결을 해제했습니다.','success');
  });
  $('#refreshBtn').addEventListener('click',async()=>{
    const button=$('#refreshBtn');busy(button,true,'불러오는 중…');
    try {
      if(!state.connected) {
        if(!state.secret){setTab('settings');notify('설정에서 SECRET을 입력하세요.','info');}
        else await connect(state.secret,false);
      } else await load();
      if(state.mutationFailed&&state.mutationQueue.length)void drainMutationQueue();
    }catch(e){notify(e.message,'error');}
    finally{busy(button,false);}
  });
  $('#addItemBtn').addEventListener('click',openAddEditor);
  $('#cancelBtn').addEventListener('click',()=>$('#editor').close());
  $('#editForm').addEventListener('submit',e=>{
    e.preventDefault();
    let item;
    try{item=formRecord();}catch(err){notify(err.message,'error');return;}
    const adding=!state.active;
    const id=adding?freshId():state.active;
    if(queueMutation(adding?'add':'edit',id,item))$('#editor').close();
  });
  $('#deleteItemBtn').addEventListener('click',()=>{
    const id=state.active;
    if(!id)return;
    const item=state.items.find(i=>i.id===id);
    if(!item)return;
    if(!window.confirm(`「${item.name}」 준비물을 삭제할까요?
삭제한 항목은 Google Sheets의 '삭제보관' 시트에 보관됩니다.`))return;
    if(queueMutation('delete',id,null))$('#editor').close();
  });
  for(const id of ['search','category','priority','status'])$('#'+id).addEventListener(id==='search'?'input':'change',render);
  try{const old=JSON.parse(safeRead(localStorage,categoryExpandKey)||'[]');
    if(Array.isArray(old))for(const [key,value] of old){if(typeof key==='string'&&typeof value==='boolean')state.expanded.set(key,value);}
  }catch(e){}
  restoreJournal();
  updateQueueView();
  updateConnectedView();
  const savedSecret=safeRead(localStorage,storageKey)||safeRead(sessionStorage,oldSessionKey);
  if(savedSecret) {
    state.secret=savedSecret;
    // Show saved results immediately; verify with the server in the background.
    const old=readItemCache();
    if(old){
      applyServerItems(old.items.map(i=>({...i,purchaseQty:Number(i.purchaseQty||0),status:i.status==='선물받음'?'구매완료':i.status})));state.cached=true;
      drawCategories();render();
      $('#syncLabel').textContent='기기 저장 목록 · 최신 정보 확인 중…';
      updateConnectedView();
    }
    connect(savedSecret,false);
  } else if (!API) {
    notify('config.js에 Apps Script 배포 URL이 없습니다. 설정을 확인하세요.','error');
  }
})();
