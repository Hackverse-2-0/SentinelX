/* ================================================================
   EcoSentinel — script.js  v2.0.0
   NEW: Live graph controls · ESP32 button commands · Email alerts
   ================================================================ */

/* ----------------------------------------------------------------
   1. GLOBAL STATE
   ---------------------------------------------------------------- */
const state   = { temp: 0, hum: 0, co2: 0, moist: 0 };
const history = { temp: [], hum: [], co2: [], moist: [], labels: [] };
let MAX_PTS   = 60;

const lastReceived = { temp: null, hum: null, co2: null, moist: null };

let pktCount      = 0;
let uptimeSeconds = 0;
let isLive        = false;
let mqttClient    = null;
let demoInterval  = null;

let _t = 52, _h = 55, _c = 720, _m = 55;

const SPARK_COLORS = { temp: '#00fff5', hum: '#39ff14', co2: '#ffe600', moist: '#bf00ff' };

const GAUGE_CONFIG = [
  { key:'temp',  label:'TEMP',  min:0, max:100,  unit:'°C',  color:'#00fff5', warn:75   },
  { key:'hum',   label:'HUM',   min:0, max:100,  unit:'%',   color:'#39ff14', warn:80   },
  { key:'co2',   label:'CO₂',   min:0, max:2000, unit:'ppm', color:'#ffe600', warn:1000 },
  { key:'moist', label:'MOIST', min:0, max:100,  unit:'%',   color:'#bf00ff', warn:75   },
];

const DEVICES = [
  { name:'ECO-NODE (ESP32)', type:'Main Microcontroller', role:'Sensor Hub',     status:'online' },
  { name:'DHT22 Sensor',     type:'Temp + Humidity',      role:'Env Monitor',    status:'online' },
  { name:'MQ135 Sensor',     type:'CO₂ / Air Quality',    role:'Gas Monitor',    status:'online' },
  { name:'Moisture Sensor',  type:'Capacitive/Resistive', role:'Soil Monitor',   status:'online' },
  { name:'Buzzer (GPIO 26)', type:'Passive Buzzer',       role:'Alert Output',   status:'online' },
  { name:'Relay (GPIO 27)',  type:'Output Actuator',      role:'Device Control', status:'online' },
  { name:'MQTT Broker',      type:'HiveMQ Public',        role:'Message Router', status:'online' },
  { name:'EcoSentinel Dash', type:'Web Dashboard v2',     role:'Visualization',  status:'online' },
];

let lastAlertTime = {};
let alertConfig   = { email:'', cooldown:300, temp:true, co2:true, moist:true, hum:false };


/* ----------------------------------------------------------------
   2. HELPERS
   ---------------------------------------------------------------- */
function pushHistory() {
  const lbl = new Date().toTimeString().substring(0,8);
  ['temp','hum','co2','moist'].forEach(k => {
    history[k].push(state[k]);
    if (history[k].length > MAX_PTS) history[k].shift();
  });
  history.labels.push(lbl);
  if (history.labels.length > MAX_PTS) history.labels.shift();
}

function trendArrow(key) {
  const h = history[key];
  if (h.length < 3) return { txt:'—', cls:'' };
  const d = h[h.length-1] - h[h.length-3];
  if (d >  0.5) return { txt:`▲ +${d.toFixed(1)}`, cls:'trend-up'   };
  if (d < -0.5) return { txt:`▼ ${d.toFixed(1)}`,  cls:'trend-down' };
  return { txt:'◆ STABLE', cls:'trend-stable' };
}

function clamp(v,min,max) { return Math.min(max, Math.max(min, v)); }


/* ----------------------------------------------------------------
   3. MQTT
   ---------------------------------------------------------------- */
function mqttConnect() {
  stopDemo();
  const host   = document.getElementById('cfg-host').value.trim()    || 'broker.hivemq.com';
  const port   = parseInt(document.getElementById('cfg-port').value) || 8884;
  const prefix = document.getElementById('cfg-topic').value.trim()   || 'ecosentinel/node1';
  const cid    = document.getElementById('cfg-clientid').value.trim()|| ('eco-dash-'+Date.now());

  if (mqttClient) { try { mqttClient.disconnect(); } catch(e){} }

  setConnState('connecting');
  connLog(`Connecting to ${host}:${port} as ${cid}...`, 'log-info');

  mqttClient = new Paho.Client(host, port, '/mqtt', cid);
  mqttClient.onConnectionLost = res => { setConnState('disconnected'); connLog(`Lost: ${res.errorMessage}`, 'log-err'); isLive=false; };
  mqttClient.onMessageArrived = msg => handleMqttMessage(msg.destinationName, msg.payloadString);

  mqttClient.connect({
    useSSL: (port===8884||port===8883), timeout:10,
    onSuccess: () => {
      setConnState('connected'); isLive=true;
      connLog(`Connected! Subscribing to ${prefix}/#`, 'log-ok');
      document.getElementById('hdr-device').textContent       = cid;
      document.getElementById('conn-stat-broker').textContent = host;
      mqttClient.subscribe(`${prefix}/#`);
      setModeBanner('live');
    },
    onFailure: err => { setConnState('disconnected'); connLog(`Failed: ${err.errorMessage}`, 'log-err'); },
  });
}

function handleMqttMessage(topic, payload) {
  const prefix = document.getElementById('cfg-topic').value.trim();

  if (topic === `${prefix}/relay/state`)    { updateRelayStatus(payload.trim()); return; }
  if (topic === `${prefix}/alert/triggered`){ showToast('⚠ ESP32 AUTO-ALERT', `Hardware alert: ${payload.trim()}`, 'crit'); return; }

  let value;
  try { value = parseFloat(JSON.parse(payload).value); } catch(e) { value = parseFloat(payload); }
  if (isNaN(value)) return;

  pktCount++;
  document.getElementById('pkt-count').textContent    = pktCount;
  document.getElementById('hdr-lastpkt').textContent  = new Date().toTimeString().substring(0,8);
  document.getElementById('conn-quality').textContent = `Pkts: ${pktCount}`;

  if      (topic===`${prefix}/temperature`) { state.temp  = value; lastReceived.temp  = Date.now(); }
  else if (topic===`${prefix}/humidity`)    { state.hum   = value; lastReceived.hum   = Date.now(); }
  else if (topic===`${prefix}/co2`)         { state.co2   = value; lastReceived.co2   = Date.now(); }
  else if (topic===`${prefix}/moisture`)    { state.moist = value; lastReceived.moist = Date.now(); }

  pushHistory(); renderAll(); checkAndTriggerAlerts();
}


/* ----------------------------------------------------------------
   4. ESP32 BUTTON CONTROL COMMANDS  (new v2)
   ---------------------------------------------------------------- */
function sendCmd(subtopic, message) {
  const prefix    = document.getElementById('cfg-topic').value.trim() || 'ecosentinel/node1';
  const fullTopic = `${prefix}/cmd/${subtopic}`;

  if (mqttClient && mqttClient.isConnected()) {
    const msg = new Paho.Message(String(message));
    msg.destinationName = fullTopic;
    msg.retained = false;
    mqttClient.send(msg);
    connLog(`CMD → ${fullTopic} = ${message}`, 'log-ok');
  } else {
    connLog(`Not connected — cmd not sent (${fullTopic})`, 'log-err');
    showToast('⚠ Not Connected', 'Connect to MQTT first to send commands.', 'warn');
  }

  // Update UI immediately for instant feedback
  if (subtopic === 'buzzer') {
    const el = document.getElementById('buzzer-status');
    el.textContent = message.toUpperCase();
    el.className   = 'ctrl-status ' + (message==='off' ? 'off' : message==='on' ? 'on' : 'warn');
  }
  if (subtopic === 'relay') updateRelayStatus(message);
  if (subtopic === 'reset') {
    document.getElementById('reset-status').textContent = 'RESETTING...';
    setTimeout(() => { document.getElementById('reset-status').textContent = 'STANDBY'; }, 5000);
  }
}

function sendIntervalCmd(ms) {
  sendCmd('interval', String(ms));
  document.getElementById('interval-status').textContent = `${ms} ms`;
}

function confirmReset() {
  if (confirm('Remotely restart the ESP32?\n\nData collection will pause for ~5 seconds.')) {
    sendCmd('reset', '1');
  }
}

function updateRelayStatus(st) {
  const el = document.getElementById('relay-status');
  if (!el) return;
  const on = (st==='on'||st==='1');
  el.textContent = on ? 'ON' : 'OFF';
  el.className   = 'ctrl-status ' + (on ? 'on' : 'off');
}


/* ----------------------------------------------------------------
   5. DEMO MODE
   ---------------------------------------------------------------- */
function randomWalk(v, delta, min, max) {
  return parseFloat(clamp(v + (Math.random()-0.46)*delta, min, max).toFixed(1));
}

function startDemo() {
  stopDemo();
  if (mqttClient) { try { mqttClient.disconnect(); } catch(e){} mqttClient=null; }
  isLive=false; setConnState('demo'); setModeBanner('demo');
  connLog('Demo mode — simulating ESP32 at 1 Hz.', 'log-info');
  document.getElementById('hdr-device').textContent = 'ECO-NODE (DEMO)';

  for (let i=0; i<30; i++) {
    _t=randomWalk(_t,1.5,20,90); _h=randomWalk(_h,2,10,99);
    _c=randomWalk(_c,30,400,1800); _m=randomWalk(_m,3,0,100);
    state.temp=_t; state.hum=_h; state.co2=_c; state.moist=_m;
    const now=Date.now();
    lastReceived.temp=lastReceived.hum=lastReceived.co2=lastReceived.moist=now;
    pushHistory();
  }
  renderAll();

  demoInterval = setInterval(() => {
    _t=randomWalk(_t,1.5,20,90); _h=randomWalk(_h,2,10,99);
    _c=randomWalk(_c,30,400,1800); _m=randomWalk(_m,3,0,100);
    state.temp=_t; state.hum=_h; state.co2=_c; state.moist=_m;
    pktCount++;
    document.getElementById('pkt-count').textContent    = pktCount;
    document.getElementById('hdr-lastpkt').textContent  = new Date().toTimeString().substring(0,8);
    document.getElementById('conn-quality').textContent = `Pkts: ${pktCount}`;
    const now=Date.now();
    lastReceived.temp=lastReceived.hum=lastReceived.co2=lastReceived.moist=now;
    pushHistory(); renderAll(); checkAndTriggerAlerts();
  }, 1000);
}

function stopDemo() { if (demoInterval) { clearInterval(demoInterval); demoInterval=null; } }


/* ----------------------------------------------------------------
   6. CHART WINDOW CONTROLS  (new v2)
   ---------------------------------------------------------------- */
function setChartWindow(val) {
  MAX_PTS = parseInt(val)||60;
  const badge = document.getElementById('chart-th-badge');
  if (badge) badge.textContent = `LAST ${MAX_PTS} READINGS`;
  ['temp','hum','co2','moist','labels'].forEach(k => { while(history[k].length>MAX_PTS) history[k].shift(); });
  updateCharts();
}

function clearHistory() {
  ['temp','hum','co2','moist','labels'].forEach(k => { history[k]=[]; });
  updateCharts(); connLog('Chart history cleared.', 'log-info');
}


/* ----------------------------------------------------------------
   7. CHARTS
   ---------------------------------------------------------------- */
const sparkCharts={};
let chartTH, chartCM;

const CHART_OPTS = {
  responsive:true, animation:{duration:200},
  plugins:{
    legend:{ labels:{color:'rgba(0,255,245,.6)', font:{family:'Share Tech Mono',size:10}, boxWidth:10} },
    tooltip:{ backgroundColor:'rgba(0,10,20,.9)', borderColor:'rgba(0,255,245,.3)', borderWidth:1, titleColor:'#00fff5', bodyColor:'rgba(0,255,245,.7)', titleFont:{family:'Share Tech Mono'}, bodyFont:{family:'Share Tech Mono'} },
  },
  scales:{
    x:  {ticks:{color:'rgba(0,255,245,.3)',font:{family:'Share Tech Mono',size:9},maxTicksLimit:8},grid:{color:'rgba(0,255,245,.04)'}},
    y:  {ticks:{color:'rgba(0,255,245,.3)',font:{family:'Share Tech Mono',size:9}},grid:{color:'rgba(0,255,245,.04)'}},
    y1: {position:'right',ticks:{color:'rgba(57,255,20,.3)',font:{family:'Share Tech Mono',size:9}},grid:{display:false}},
  },
};

function initSparklines() {
  Object.entries(SPARK_COLORS).forEach(([key,color]) => {
    const ctx=document.getElementById('spark-'+key).getContext('2d');
    sparkCharts[key]=new Chart(ctx,{type:'line',data:{labels:[],datasets:[{data:[],borderColor:color,borderWidth:1.5,pointRadius:0,tension:.4,fill:true,backgroundColor:color+'18'}]},options:{responsive:true,animation:false,plugins:{legend:{display:false},tooltip:{enabled:false}},scales:{x:{display:false},y:{display:false}}}});
  });
}

function initCharts() {
  chartTH=new Chart(document.getElementById('chart-temp-hum').getContext('2d'),{type:'line',data:{labels:[],datasets:[
    {label:'TEMP (°C)',    data:[],borderColor:'#00fff5',backgroundColor:'rgba(0,255,245,.04)',borderWidth:2,pointRadius:0,tension:.4,fill:true, yAxisID:'y'},
    {label:'HUMIDITY (%)',data:[],borderColor:'#39ff14',backgroundColor:'rgba(57,255,20,.04)', borderWidth:2,pointRadius:0,tension:.4,fill:false,yAxisID:'y1'},
  ]},options:{...CHART_OPTS}});

  chartCM=new Chart(document.getElementById('chart-co2-moist').getContext('2d'),{type:'line',data:{labels:[],datasets:[
    {label:'CO₂ (ppm)',   data:[],borderColor:'#ffe600',backgroundColor:'rgba(255,230,0,.04)', borderWidth:2,pointRadius:0,tension:.4,fill:true, yAxisID:'y'},
    {label:'MOISTURE (%)',data:[],borderColor:'#bf00ff',backgroundColor:'rgba(191,0,255,.04)',borderWidth:2,pointRadius:0,tension:.4,fill:false,yAxisID:'y1'},
  ]},options:{...CHART_OPTS,scales:{...CHART_OPTS.scales,y1:{...CHART_OPTS.scales.y1,ticks:{color:'rgba(191,0,255,.3)',font:{family:'Share Tech Mono',size:9}}}}}});
}

function updateCharts() {
  Object.keys(SPARK_COLORS).forEach(k => {
    sparkCharts[k].data.labels=history.labels.slice(-20);
    sparkCharts[k].data.datasets[0].data=history[k].slice(-20);
    sparkCharts[k].update('none');
  });
  chartTH.data.labels=chartCM.data.labels=[...history.labels];
  chartTH.data.datasets[0].data=[...history.temp];
  chartTH.data.datasets[1].data=[...history.hum];
  chartCM.data.datasets[0].data=[...history.co2];
  chartCM.data.datasets[1].data=[...history.moist];
  chartTH.update('none'); chartCM.update('none');
}


/* ----------------------------------------------------------------
   8. GAUGES
   ---------------------------------------------------------------- */
function initGauges() {
  const container=document.getElementById('gauges-wrap');
  GAUGE_CONFIG.forEach(cfg => {
    const r=36,cx=50,cy=52;
    const wrap=document.createElement('div');
    wrap.className='gauge-wrap'; wrap.id='gauge-'+cfg.key;
    wrap.innerHTML=`<svg width="96" height="76" viewBox="0 0 100 76"><defs><filter id="glow-${cfg.key}"><feGaussianBlur stdDeviation="2.5" result="coloredBlur"/><feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path d="M${cx-r},${cy} A${r},${r},0,0,1,${cx+r},${cy}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="6" stroke-linecap="round"/><path id="arc-${cfg.key}" d="M${cx-r},${cy} A${r},${r},0,0,1,${cx+r},${cy}" fill="none" stroke="${cfg.color}" stroke-width="6" stroke-linecap="round" filter="url(#glow-${cfg.key})" stroke-dasharray="0 1000" style="transition:stroke-dasharray .5s ease;"/><text id="gauge-val-${cfg.key}" x="${cx}" y="${cy-4}" text-anchor="middle" font-family="Orbitron,monospace" font-size="11" font-weight="700" fill="${cfg.color}" filter="url(#glow-${cfg.key})">--</text><text x="${cx}" y="${cy+11}" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="8" fill="rgba(0,255,245,.35)">${cfg.unit}</text></svg><div class="gauge-label">${cfg.label}</div>`;
    container.appendChild(wrap);
  });
}

function updateGauges() {
  const circ=Math.PI*36;
  GAUGE_CONFIG.forEach(cfg => {
    const val=state[cfg.key];
    const pct=clamp((val-cfg.min)/(cfg.max-cfg.min),0,1);
    const isWarn=(val>cfg.warn);
    const arc=document.getElementById('arc-'+cfg.key);
    const valEl=document.getElementById('gauge-val-'+cfg.key);
    if (arc)  { arc.setAttribute('stroke-dasharray',`${circ*pct} ${circ}`); arc.setAttribute('stroke',isWarn?'#ff2d78':cfg.color); }
    if (valEl){ valEl.textContent=cfg.unit==='ppm'?Math.round(val):val.toFixed(1); valEl.setAttribute('fill',isWarn?'#ff2d78':cfg.color); }
  });
}


/* ----------------------------------------------------------------
   9. ALERT SYSTEM + EMAIL  (new v2)
   ---------------------------------------------------------------- */
function saveAlertConfig() {
  alertConfig.email    = document.getElementById('alert-email').value.trim();
  alertConfig.cooldown = parseInt(document.getElementById('alert-cooldown').value)||300;
  alertConfig.temp     = document.getElementById('alert-toggle-temp').checked;
  alertConfig.co2      = document.getElementById('alert-toggle-co2').checked;
  alertConfig.moist    = document.getElementById('alert-toggle-moist').checked;
  alertConfig.hum      = document.getElementById('alert-toggle-hum').checked;
  document.getElementById('email-status').textContent='✓ Config saved';
  setTimeout(()=>{ document.getElementById('email-status').textContent=''; },2000);
}

function checkAndTriggerAlerts() {
  const now=Math.floor(Date.now()/1000);
  const checks=[
    {key:'temp_high', active:alertConfig.temp,  trigger:state.temp>75,   level:'crit', msg:`Temperature critical: ${state.temp.toFixed(1)}°C (limit 75°C)`},
    {key:'co2_warn',  active:alertConfig.co2,   trigger:state.co2>1000,  level:'warn', msg:`CO₂ elevated: ${Math.round(state.co2)}ppm (limit 1000ppm)`},
    {key:'co2_crit',  active:alertConfig.co2,   trigger:state.co2>1500,  level:'crit', msg:`CO₂ CRITICAL: ${Math.round(state.co2)}ppm! Ventilate NOW.`},
    {key:'moist_low', active:alertConfig.moist, trigger:state.moist<25,  level:'crit', msg:`Soil critically dry: ${state.moist.toFixed(1)}%`},
    {key:'hum_high',  active:alertConfig.hum,   trigger:state.hum>80,    level:'warn', msg:`High humidity: ${state.hum.toFixed(1)}%RH`},
  ];
  checks.forEach(c => {
    if (!c.active||!c.trigger) return;
    if (now-(lastAlertTime[c.key]||0) < alertConfig.cooldown) return;
    lastAlertTime[c.key]=now;
    showToast(c.level==='crit'?'🔴 CRITICAL ALERT':'🟡 WARNING', c.msg, c.level);
    if (alertConfig.email) sendAlertEmail(c.level, c.msg);
  });
}

let activeToast=null;
function showToast(title, body, level='warn') {
  if (activeToast) { activeToast.remove(); activeToast=null; }
  const toast=document.createElement('div');
  toast.className=`alert-toast ${level==='crit'?'':'warn'}`;
  toast.innerHTML=`<div class="toast-title">${title}</div><div class="toast-body">${body}</div><div class="toast-time">${new Date().toTimeString().substring(0,8)} · Click to dismiss</div>`;
  toast.onclick=()=>{ toast.remove(); activeToast=null; };
  document.body.appendChild(toast);
  activeToast=toast;
  setTimeout(()=>{ if(toast.parentNode){toast.remove();activeToast=null;} },8000);
}

function sendAlertEmail(level, message) {
  if (!alertConfig.email) return;
  const subject=`[EcoSentinel] ${level==='crit'?'CRITICAL':'WARNING'} Alert`;
  const body=`EcoSentinel Alert\n\nLevel: ${level.toUpperCase()}\nMessage: ${message}\nTime: ${new Date().toISOString()}\n\nReadings:\n  Temp:     ${state.temp.toFixed(1)} °C\n  Humidity: ${state.hum.toFixed(1)} %\n  CO2:      ${Math.round(state.co2)} ppm\n  Moisture: ${state.moist.toFixed(1)} %\n\n-- EcoSentinel v2.0.0`;
  window.open(`mailto:${alertConfig.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
}

function sendTestEmail() {
  saveAlertConfig();
  if (!alertConfig.email) { document.getElementById('email-status').textContent='⚠ Enter email first'; return; }
  document.getElementById('email-status').textContent='📧 Opening mail client...';
  sendAlertEmail('test', 'This is a test alert from EcoSentinel v2.0.0');
  setTimeout(()=>{ document.getElementById('email-status').textContent=''; },3000);
}

function checkAlerts() {
  const a=[];
  if (state.temp>75)    a.push({type:'crit',icon:'🔴',title:'HIGH TEMPERATURE', desc:`${state.temp.toFixed(1)}°C — exceeds 75°C limit.`});
  else if(state.temp<30) a.push({type:'info',icon:'🔵',title:'LOW TEMPERATURE',  desc:`${state.temp.toFixed(1)}°C — below normal range.`});
  if (state.hum>80)     a.push({type:'warn',icon:'🟡',title:'HIGH HUMIDITY',    desc:`${state.hum.toFixed(1)}%RH — condensation risk.`});
  else if(state.hum<25)  a.push({type:'warn',icon:'🟡',title:'LOW HUMIDITY',     desc:`${state.hum.toFixed(1)}%RH — dry conditions.`});
  if (state.co2>1500)   a.push({type:'crit',icon:'🔴',title:'CRITICAL CO₂',    desc:`${Math.round(state.co2)}ppm — immediate safety risk!`});
  else if(state.co2>1000) a.push({type:'warn',icon:'🟡',title:'ELEVATED CO₂',   desc:`${Math.round(state.co2)}ppm — ventilation recommended.`});
  if (state.moist>80)   a.push({type:'warn',icon:'🟡',title:'WATERLOGGED SOIL', desc:`${state.moist.toFixed(1)}% — overwatering risk.`});
  else if(state.moist<25) a.push({type:'crit',icon:'🔴',title:'DRY SOIL',       desc:`${state.moist.toFixed(1)}% — plant stress likely.`});
  if (a.length===0) a.push({type:'ok',icon:'🟢',title:'ALL SYSTEMS NOMINAL',desc:'All readings within acceptable ranges.'});
  return a;
}

function updateAlerts() {
  const alerts=checkAlerts();
  document.getElementById('alert-count').textContent=alerts.filter(a=>a.type!=='ok').length+' ACTIVE';
  const now=new Date().toTimeString().substring(0,8);
  document.getElementById('alerts-container').innerHTML=alerts.slice(0,5).map(a=>`<div class="alert-item alert-${a.type}"><div class="alert-icon">${a.icon}</div><div class="alert-body"><div class="alert-title">${a.title}</div><div class="alert-desc">${a.desc}</div></div><div class="alert-time">${now}</div></div>`).join('');
}


/* ----------------------------------------------------------------
   10. SUGGESTIONS
   ---------------------------------------------------------------- */
function updateSuggestions() {
  const s=[];
  if (state.temp>75) s.push({cls:'crit',head:'⚡ COOL DOWN IMMEDIATELY',text:'Temperature critical. Reduce system load, verify cooling, shutdown if rising.'});
  else if(state.temp>65) s.push({cls:'warn',head:'⚠ THERMAL WARNING',text:'Approaching thermal limit. Ensure ventilation and clean heat sinks.'});
  else s.push({cls:'ok',head:'✓ THERMAL NOMINAL',text:'Temperature within safe range.'});
  if (state.moist<25) s.push({cls:'crit',head:'⚡ WATER YOUR PLANT',text:'Soil critically dry. Irrigate immediately to prevent damage.'});
  else if(state.moist<40) s.push({cls:'warn',head:'⚠ LOW MOISTURE',text:'Soil getting dry. Consider watering soon.'});
  else if(state.moist>80) s.push({cls:'warn',head:'⚠ OVERWATERING RISK',text:'Soil saturated. Pause irrigation, check drainage.'});
  if (state.co2>1500) s.push({cls:'crit',head:'⚡ VENTILATE NOW',text:'CO₂ at dangerous levels. Open windows/vents immediately.'});
  else if(state.co2>1000) s.push({cls:'warn',head:'⚠ INCREASE AIRFLOW',text:'CO₂ above safe threshold. Increase fresh air intake.'});
  if (state.hum>80) s.push({cls:'warn',head:'⚠ DEHUMIDIFY',text:'High humidity risks PCB corrosion. Run a dehumidifier.'});
  if (s.length===1) s.push({cls:'ok',head:'✓ ENVIRONMENT OPTIMAL',text:'All environmental parameters within ideal ranges.'});
  document.getElementById('suggestions-container').innerHTML=s.slice(0,4).map(x=>`<div class="suggestion ${x.cls}"><div class="suggestion-head">${x.head}</div><div class="suggestion-text">${x.text}</div></div>`).join('');
}


/* ----------------------------------------------------------------
   11. UI
   ---------------------------------------------------------------- */
function updateStatCards() {
  document.getElementById('temp-val').textContent  = state.temp.toFixed(1);
  document.getElementById('hum-val').textContent   = state.hum.toFixed(1);
  document.getElementById('co2-val').textContent   = Math.round(state.co2);
  document.getElementById('moist-val').textContent = state.moist.toFixed(1);
  const bar=document.getElementById('moist-bar');
  bar.style.width     = clamp(state.moist,0,100)+'%';
  bar.style.background= state.moist<30?'var(--neon-pink)':state.moist>70?'var(--neon-yellow)':'var(--neon-purple)';
  ['temp','hum','co2','moist'].forEach(k => {
    const tr=trendArrow(k); const el=document.getElementById(k+'-trend');
    if(el){el.textContent=tr.txt; el.className='card-trend '+tr.cls;}
  });
  const tv=document.getElementById('temp-val');
  if(state.temp>75){tv.style.color='var(--neon-pink)'; tv.style.textShadow='0 0 20px rgba(255,45,120,.6)';}
  else{tv.style.color='var(--neon-cyan)'; tv.style.textShadow='0 0 20px rgba(0,255,245,.5)';}
}

function updateLastSeenAges() {
  ['temp','hum','co2','moist'].forEach(k => {
    const el=document.getElementById(k+'-age'); if(!el) return;
    if(!lastReceived[k]){el.textContent='—';el.style.color='var(--text-dim)';return;}
    const ago=Math.round((Date.now()-lastReceived[k])/1000);
    el.textContent=ago<5?'● LIVE':`Last: ${ago}s ago`;
    el.style.color=ago<5?'var(--neon-green)':ago<=10?'var(--neon-yellow)':'var(--neon-pink)';
  });
}

function buildDeviceTable() {
  document.getElementById('device-table').innerHTML=DEVICES.map(d=>`<div class="device-row"><span class="device-name">${d.name}</span><span class="device-type">${d.type}</span><span class="device-role">${d.role}</span><span class="device-status status-${d.status}">${d.status.toUpperCase()}</span></div>`).join('');
}

function updateTicker() {
  const ac=checkAlerts().filter(a=>a.type!=='ok').length;
  const t=`ECOSENTINEL v2  |  TEMP:${state.temp.toFixed(1)}°C  |  HUM:${state.hum.toFixed(1)}%  |  CO₂:${Math.round(state.co2)}ppm  |  MOISTURE:${state.moist.toFixed(1)}%  |  PKTS:${pktCount}  |  ALERTS:${ac}  |  UPTIME:${document.getElementById('uptime').textContent}  `;
  document.getElementById('ticker-text').textContent=t.repeat(4);
}

function setConnState(s) {
  const badge=document.getElementById('conn-badge'),dot=document.getElementById('main-dot'),txt=document.getElementById('main-status-text'),cval=document.getElementById('conn-stat-val'),fmode=document.getElementById('footer-mode');
  const L={connected:'CONNECTED',connecting:'CONNECTING...',disconnected:'DISCONNECTED',demo:'DEMO MODE'};
  badge.className='conn-badge badge-'+s; badge.textContent=L[s]||s.toUpperCase();
  switch(s){
    case 'connected':   dot.className='pulse-dot';       txt.textContent='LIVE FEED';    txt.style.color='var(--neon-green)';  cval.textContent='LIVE'; cval.style.color='var(--neon-green)';  fmode.textContent='LIVE';  break;
    case 'connecting':  dot.className='pulse-dot yellow'; txt.textContent='CONNECTING...';txt.style.color='var(--neon-yellow)'; cval.textContent='...';  fmode.textContent='...';  break;
    case 'demo':        dot.className='pulse-dot';        txt.textContent='DEMO MODE';   txt.style.color='var(--neon-blue)';   cval.textContent='DEMO'; cval.style.color='var(--neon-blue)';   fmode.textContent='DEMO';  document.getElementById('conn-stat-broker').textContent='Simulated Data'; break;
    default:            dot.className='pulse-dot red';    txt.textContent='DISCONNECTED'; txt.style.color='var(--neon-pink)';   cval.textContent='OFF';  cval.style.color='var(--neon-pink)';   fmode.textContent='OFFLINE';
  }
}

function setModeBanner(mode) {
  const b=document.getElementById('mode-banner');
  b.className='mode-banner '+mode;
  b.innerHTML=mode==='live'?'<span>●</span> LIVE MODE — Receiving real data from your ESP32 via MQTT.':'<span>●</span> DEMO MODE — Simulated data. Connect your ESP32 via MQTT to see live readings.';
}

function connLog(msg,cls='') {
  const box=document.getElementById('conn-log');
  const line=document.createElement('div');
  if(cls) line.className=cls;
  line.innerHTML=`▸ ${msg}`;
  box.appendChild(line); box.scrollTop=box.scrollHeight;
  while(box.childNodes.length>50) box.removeChild(box.firstChild);
}

function updateClock() {
  const now=new Date();
  document.getElementById('clock').textContent=now.toISOString().replace('T',' ').substring(0,19)+' UTC';
  uptimeSeconds++;
  const h=String(Math.floor(uptimeSeconds/3600)).padStart(2,'0');
  const m=String(Math.floor((uptimeSeconds%3600)/60)).padStart(2,'0');
  const s=String(uptimeSeconds%60).padStart(2,'0');
  document.getElementById('uptime').textContent=`${h}:${m}:${s}`;
  updateLastSeenAges();
}

function renderAll() {
  updateStatCards(); updateCharts(); updateGauges(); updateAlerts(); updateSuggestions(); updateTicker();
}


/* ----------------------------------------------------------------
   12. INIT
   ---------------------------------------------------------------- */
(function init() {
  initSparklines(); initCharts(); initGauges(); buildDeviceTable();
  setInterval(updateClock,1000); updateClock();
  startDemo();
})();
