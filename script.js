/* ---------- Utilities ---------- */
const $ = id => document.getElementById(id);
const fmt = v => Number(v).toLocaleString(undefined,{maximumFractionDigits:2});
const ymd = d => d.toISOString().slice(0,10);
const formatNice = d => new Date(d).toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'});

/* date helpers */
function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) { d.setDate(0); }
  return d;
}

/* EMI formula */
function computeEmi(principal, monthlyRate, months){
  if(months <= 0) return months === 0 ? principal : 0;
  if(monthlyRate === 0) return principal / months;
  return principal * monthlyRate * Math.pow(1+monthlyRate, months) / (Math.pow(1+monthlyRate, months) - 1);
}

/* ROI selection: get latest ROI change with date <= paymentDate */
function getRateForDate(paymentDate, roiChanges, initialRate){
  if(!roiChanges || roiChanges.length === 0) return initialRate;
  const pd = new Date(paymentDate.getTime()); pd.setHours(0,0,0,0);
  let applicable = null;
  for(const r of roiChanges){
    const rd = new Date(r.date + 'T00:00:00');
    if(rd <= pd){
      if(!applicable || rd > new Date(applicable.date + 'T00:00:00')) applicable = r;
    }
  }
  return applicable ? parseFloat(applicable.rate) : initialRate;
}

/* buildSchedule: returns {rows:[], monthsTaken, baseEmi}
   prepayments: [{type:'one'|'recurring', amount:number, date:'YYYY-MM-DD', strategy:'reduceEmi'|'reduceTenure'}]
   roiChanges sorted ascending by date: [{date, rate}]
*/
function buildSchedule(principal, initialRate, totalMonths, startDate, prepayments=[], roiChanges=[]){
  const rows = [];
  let outstanding = principal;
  let month = 1;
  const maxIter = totalMonths + 600;
  const baseEmiInitial = computeEmi(principal, initialRate/1200, totalMonths);
  let currentEmi = computeEmi(principal, initialRate/1200, totalMonths);

  while(outstanding > 0.005 && month <= maxIter){
    const paymentDate = addMonths(new Date(startDate.getTime()), month-1);

    // pick applicable monthly rate
    const applicableRate = getRateForDate(new Date(paymentDate.getTime()), roiChanges, initialRate);
    const monthlyRate = applicableRate / 1200;

    // interest & principal part for this month
    let interest = outstanding * monthlyRate;
    let principalPart = Math.max(0, Math.min(currentEmi - interest, outstanding));

    // find prepayments for this EMI (one-time: same month+year; recurring: p.date <= paymentDate)
    let prepayThisMonth = 0;
    const prepayActions = [];
    for(const p of prepayments){
      if(!p.date) continue;
      const pDate = new Date(p.date + 'T00:00:00');
      if(p.type === 'one'){
        if(pDate.getFullYear() === paymentDate.getFullYear() && pDate.getMonth() === paymentDate.getMonth()){
          const allowed = Math.max(0, outstanding - principalPart);
          const applyAmt = Math.min(p.amount, allowed);
          if(applyAmt > 0){ prepayThisMonth += applyAmt; prepayActions.push(p); }
        }
      } else if(p.type === 'recurring'){
        if(paymentDate >= pDate){
          const allowed = Math.max(0, outstanding - principalPart);
          const applyAmt = Math.min(p.amount, allowed);
          if(applyAmt > 0){ prepayThisMonth += applyAmt; prepayActions.push(p); }
        }
      }
    }

    // detect if any applied prepay asks to reduce EMI
    const anyReduceEmi = prepayActions.some(a => a.strategy === 'reduceEmi');

    const paidEmi = principalPart + interest;
    const closing = Math.max(0, outstanding - principalPart - prepayThisMonth);

    rows.push({
      month,
      date: new Date(paymentDate.getTime()),
      roi: monthlyRate * 1200,
      opening: outstanding,
      emi: paidEmi,
      interest,
      principal: principalPart,
      prepay: prepayThisMonth,
      closing
    });

    outstanding = closing;

    // after applying prepayment(s), recompute EMI if reduceEmi requested (to amortize over remaining original months)
    if(anyReduceEmi && outstanding > 0.005){
      const monthsGone = month;
      const monthsLeft = Math.max(1, totalMonths - monthsGone);
      currentEmi = computeEmi(outstanding, monthlyRate, monthsLeft);
    } else {
      // keep currentEmi unchanged (reduce tenure)
      if(outstanding > 0.005 && currentEmi < 0.00001){
        currentEmi = computeEmi(outstanding, monthlyRate, Math.max(1, totalMonths - month));
      }
    }

    month++;
    if(month > 5000) break;
  }

  return { rows, monthsTaken: rows.length, baseEmi: baseEmiInitial };
}

/* ---------- DOM Builders for ROI & Prepayments ---------- */
function createRoiElement(pref = {}) {
  const dom = document.createElement('div');
  dom.className = 'list-item border rounded p-2 mb-2';

  dom.innerHTML = `
    <div class="row g-2 align-items-end">
      <div class="col-5">
        <label class="form-label small">Date</label>
        <input class="rdate form-control form-control-sm" type="date">
      </div>
      <div class="col-5">
        <label class="form-label small">Annual %</label>
        <input class="rrate form-control form-control-sm" type="number" step="0.01" placeholder="Annual %">
      </div>
      <div class="col-2 text-end">
        <button class="remove-roi btn btn-sm btn-danger">✕</button>
      </div>
    </div>
  `;

  if (pref.date) dom.querySelector('.rdate').value = pref.date;
  if (pref.rate !== undefined) dom.querySelector('.rrate').value = pref.rate;

  dom.querySelector('.remove-roi').addEventListener('click', () => { dom.remove(); scheduleSave(); });
  dom.querySelector('.rdate').addEventListener('change', scheduleSave);
  dom.querySelector('.rrate').addEventListener('input', scheduleSave);

  return dom;
}


function createPrepayElement(pref = {}) {
  const dom = document.createElement('div');
  dom.className = 'list-item border rounded p-2 mb-2';

  dom.innerHTML = `
    <div class="row g-2 align-items-end">
      <div class="col-6">
        <label class="form-label small">Type</label>
        <select class="ptype form-select form-select-sm">
          <option value="one">One-time</option>
          <option value="recurring">Recurring</option>
        </select>
      </div>

      <div class="col-6">
        <label class="form-label small">Amount</label>
        <input class="pamt form-control form-control-sm" type="number" placeholder="Amount">
      </div>

      <div class="col-6">
        <label class="form-label small">Date</label>
        <input class="pdate form-control form-control-sm" type="date">
      </div>

      <div class="col-5">
        <label class="form-label small">Strategy</label>
        <select class="pstrategy form-select form-select-sm">
          <option value="reduceTenure">Reduce Tenure</option>
          <option value="reduceEmi">Reduce EMI</option>
        </select>
      </div>

      <div class="col-1 text-end">
        <button class="remove-pre btn btn-sm btn-danger">✕</button>
      </div>
    </div>
  `;

  /* restore values */
  if (pref.type) dom.querySelector('.ptype').value = pref.type;
  if (pref.amount !== undefined) dom.querySelector('.pamt').value = pref.amount;
  if (pref.date) dom.querySelector('.pdate').value = pref.date;
  if (pref.strategy) dom.querySelector('.pstrategy').value = pref.strategy;

  /* events (UNCHANGED LOGIC) */
  dom.querySelector('.remove-pre').addEventListener('click', () => {
    dom.remove();
    scheduleSave();
  });

  dom.querySelector('.ptype').addEventListener('change', scheduleSave);
  dom.querySelector('.pamt').addEventListener('input', scheduleSave);
  dom.querySelector('.pdate').addEventListener('change', scheduleSave);
  dom.querySelector('.pstrategy').addEventListener('change', scheduleSave);

  return dom;
}


/* ---------- Handlers ---------- */
$('addRoi').addEventListener('click', ()=> {
  $('roiList').appendChild(createRoiElement({date: ymd(new Date()), rate: parseFloat($('initialRate').value)||0}));
  scheduleSave();
});
$('clearRoi').addEventListener('click', ()=> { $('roiList').innerHTML = ''; scheduleSave(); });
$('addPrepay').addEventListener('click', ()=> {
  $('prepayList').appendChild(createPrepayElement({type:'one', amount:100000, date: ymd(new Date()), strategy:'reduceTenure'}));
  scheduleSave();
});
$('clearPrepay').addEventListener('click', ()=> { $('prepayList').innerHTML = ''; scheduleSave(); });

/* ---------- Chart (compare baseline vs withPrepay) ---------- */
let chartInst = null;
function renderCompareChart(baseline, withPrepay){
  const ctx = $('compareChart');
  // union dates (YYYY-MM-DD)
  const set = new Set();
  baseline.rows.forEach(r => set.add(ymd(r.date)));
  withPrepay.rows.forEach(r => set.add(ymd(r.date)));
  const allDates = Array.from(set).sort();
  const mapBase = new Map(baseline.rows.map(r => [ymd(r.date), r.closing]));
  const mapPre = new Map(withPrepay.rows.map(r => [ymd(r.date), r.closing]));
  const baseData = allDates.map(d => mapBase.has(d) ? mapBase.get(d) : null);
  const preData = allDates.map(d => mapPre.has(d) ? mapPre.get(d) : null);
  const labels = allDates.map(d => (new Date(d + 'T00:00:00')).toLocaleDateString(undefined,{month:'short',year:'numeric'}));

  if(chartInst) chartInst.destroy();
  chartInst = new Chart(ctx, {
    type:'line',
    data:{
      labels,
      datasets:[
        { label:'Baseline', data: baseData, borderColor:'#94a3b8', borderWidth:2, spanGaps:true, fill:false, tension:0.2 },
        { label:'With Prepay', data: preData, borderColor:'#2563eb', borderWidth:2, spanGaps:true, fill:false, tension:0.2 }
      ]
    },
    options:{plugins:{legend:{position:'top'}}, scales:{y:{beginAtZero:false}}}
  });
}

/* ---------- Per-prepayment marginal savings ----------
   Approach:
   - Sort prepayments chronologically.
   - For i-th prepayment: compute schedule with prepayments[0..i-1] (prevSchedule)
     then schedule with prepayments[0..i] (newSchedule)
   - Marginal saving = interest(prev) - interest(new), months saved = months(prev)-months(new)
*/
function computePerPrepaySavings(principal, initialRate, totalMonths, startDate, prepayments, roiChanges){
  const sorted = [...prepayments].sort((a,b)=> new Date(a.date) - new Date(b.date));
  const results = [];
  let applied = [];
  // baseline for comparison (no prepayments)
  const baselineAll = buildSchedule(principal, initialRate, totalMonths, startDate, [], roiChanges);
  let prevSchedule = baselineAll;
  for(let i=0;i<sorted.length;i++){
    applied.push(sorted[i]);
    const newSchedule = buildSchedule(principal, initialRate, totalMonths, startDate, applied, roiChanges);
    const prevInterest = prevSchedule.rows.reduce((s,r)=>s+(r.interest||0),0);
    const newInterest = newSchedule.rows.reduce((s,r)=>s+(r.interest||0),0);
    const marginalInterestSaved = prevInterest - newInterest;
    const monthsSaved = prevSchedule.monthsTaken - newSchedule.monthsTaken;
    results.push({
      prepay: sorted[i],
      interestSaved: marginalInterestSaved,
      monthsSaved
    });
    prevSchedule = newSchedule;
  }
  return results;
}

/* ---------- Persistence (localStorage) ---------- */
const STORAGE_KEY = 'homeloanApp_state_v1';
let saveTimer = null;
function scheduleSave(){
  // debounce saves
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 450);
}

function saveState(){
  try {
    const state = {
      principal: $('principal').value,
      years: $('years').value,
      months: $('months').value,
      startDate: $('startDate').value,
      initialRate: $('initialRate').value,
      roi: [...document.querySelectorAll('#roiList .list-item')].map(el=>({
        date: el.querySelector('.rdate').value,
        rate: el.querySelector('.rrate').value
      })),
      prepay: [...document.querySelectorAll('#prepayList .list-item')].map(el=>({
        type: el.querySelector('.ptype').value,
        amount: el.querySelector('.pamt').value,
        date: el.querySelector('.pdate').value,
        strategy: el.querySelector('.pstrategy').value
      }))
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // console.log('Saved state');
  } catch(e){ console.warn('Save failed', e); }
}

function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return false;
    const state = JSON.parse(raw);
    if(state.principal !== undefined) $('principal').value = state.principal;
    if(state.years !== undefined) $('years').value = state.years;
    if(state.months !== undefined) $('months').value = state.months;
    if(state.startDate !== undefined && state.startDate) $('startDate').value = state.startDate;
    if(state.initialRate !== undefined) $('initialRate').value = state.initialRate;

    // rebuild lists
    $('roiList').innerHTML = '';
    (state.roi || []).forEach(r => {
      if(r && r.date) $('roiList').appendChild(createRoiElement({date: r.date, rate: r.rate}));
    });

    $('prepayList').innerHTML = '';
    (state.prepay || []).forEach(p => {
      if(p && p.date) $('prepayList').appendChild(createPrepayElement({type:p.type, amount:p.amount, date:p.date, strategy:p.strategy}));
    });

    return true;
  } catch(e){ console.warn('Load failed', e); return false; }
}

/* ---------- Main calculate & render ---------- */
function calculateAll(){
  const P = parseFloat($('principal').value) || 0;
  const initialRate = parseFloat($('initialRate').value) || 0;
  const years = parseInt($('years').value) || 0;
  const extraMonths = parseInt($('months').value) || 0;
  const totalMonths = years*12 + extraMonths;
  const startDateVal = $('startDate').value;
  const startDate = startDateVal ? new Date(startDateVal + 'T00:00:00') : new Date();

  // collect ROI changes and sort ascending
  const roiChanges = [...document.querySelectorAll('#roiList .list-item')].map(el=>({
    date: el.querySelector('.rdate').value,
    rate: parseFloat(el.querySelector('.rrate').value)
  })).filter(r=>r.date && !isNaN(r.rate)).sort((a,b)=> new Date(a.date) - new Date(b.date));

  // collect prepayments (filter invalid)
  const prepayments = [...document.querySelectorAll('#prepayList .list-item')].map(el=>({
    type: el.querySelector('.ptype').value,
    amount: parseFloat(el.querySelector('.pamt').value) || 0,
    date: el.querySelector('.pdate').value,
    strategy: el.querySelector('.pstrategy').value
  })).filter(p=>p.date && p.amount > 0).sort((a,b)=> new Date(a.date) - new Date(b.date));

  // baseline and withPrepay schedules
const baseline = buildSchedule(P, initialRate, totalMonths, startDate, [], []);

  const withPrepay = buildSchedule(P, initialRate, totalMonths, startDate, prepayments, roiChanges);

  // summary numbers
  const baseInterest = baseline.rows.reduce((s,r)=>s + (r.interest||0), 0);
  const baseTotal = baseline.rows.reduce((s,r)=>s + (r.emi||0), 0);
  const withInterest = withPrepay.rows.reduce((s,r)=>s + (r.interest||0), 0);
  const withTotal = withPrepay.rows.reduce((s,r)=>s + (r.emi||0) + (r.prepay||0), 0);

  $('emi').textContent = fmt(baseline.baseEmi || 0);
  $('totalInterest').textContent = fmt(baseInterest);
  $('totalPayment').textContent = fmt(baseTotal);

  const savedInterest = baseInterest - withInterest;
  const savedMonths = baseline.monthsTaken - withPrepay.monthsTaken;
  $('afterPrepay').textContent = `${withPrepay.monthsTaken} mo | Saved interest: ${fmt(savedInterest)} | Saved months: ${savedMonths}`;

  // Remaining months countdown (live)
  const remainingMonths = withPrepay.monthsTaken;
  const yearsLeft = Math.floor(remainingMonths / 12);
  const monthsLeft = remainingMonths % 12;
  $('remainingCountdown').textContent = `Remaining: ${remainingMonths} months (${yearsLeft}y ${monthsLeft}m)`;

  // table (with prepay)
  const tbody = $('scheduleTable').querySelector('tbody');
  tbody.innerHTML = '';
  withPrepay.rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td style="text-align:center">${r.month}</td>
                    <td style="text-align:center">${formatNice(r.date)}</td>
                    <td>${(r.roi||0).toFixed(2)}</td>
                    <td>${fmt(r.opening)}</td>
                    <td>${fmt(r.emi)}</td>
                    <td>${fmt(r.interest)}</td>
                    <td>${fmt(r.principal)}</td>
                    <td>${fmt(r.prepay)}</td>
                    <td>${fmt(r.closing)}</td>`;
    tbody.appendChild(tr);
  });

  // chart
  try { renderCompareChart(baseline, withPrepay); } catch(e){ console.warn('Chart render failed', e); }

  // per-prepayment marginal savings
  const perSavings = computePerPrepaySavings(P, initialRate, totalMonths, startDate, prepayments, roiChanges);
  const savingsList = $('savingsList');
  savingsList.innerHTML = '';
  if(perSavings.length === 0) savingsList.innerHTML = '<div class="muted">No prepayments defined.</div>';
  perSavings.forEach((s, idx) => {
    const p = s.prepay;
    const node = document.createElement('div');
    node.style.padding = '6px 0';
    node.innerHTML = `<strong>Prepayment ${idx+1}:</strong> ${formatNice(new Date(p.date + 'T00:00:00'))} — ${fmt(p.amount)} — <em>${p.strategy}</em>
      <div class="muted">Interest saved: ${fmt(s.interestSaved)} | Months saved: ${s.monthsSaved}</div>`;
    savingsList.appendChild(node);
  });

  // save last
  window._last = { baseline, withPrepay, roiChanges, prepayments, startDate };
  scheduleSave();
}

/* ---------- CSV Export ---------- */
$('exportCsv').addEventListener('click', ()=>{
  const rows = window._last?.withPrepay?.rows;
  if(!rows){ alert('Run calculation first'); return; }
  const header = ['Month','Date','ROI%','Opening','EMI','Interest','Principal','Prepay','Closing'];
  const lines = rows.map(r => [
    r.month,
    `"${ymd(r.date)}"`,
    (r.roi||0).toFixed(2),
    r.opening.toFixed(2),
    r.emi.toFixed(2),
    r.interest.toFixed(2),
    r.principal.toFixed(2),
    r.prepay.toFixed(2),
    r.closing.toFixed(2)
  ].join(','));
  const csv = [header.join(',')].concat(lines).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'amortization_with_prepay.csv'; a.click();
});


/* ---------- PDF Export (with chart image) ---------- */
$('exportPdf').addEventListener('click', async ()=>{
  if(!window._last){ alert('Run calculation first'); return; }
  // Capture chart as image (dataURL)
  try {
    const canvas = $('compareChart');
    if(!canvas) throw new Error('Chart canvas not found.');
    const imgData = canvas.toDataURL('image/png', 1.0);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({unit:'pt', format:'a4'});
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 40;
    let y = margin;

    doc.setFontSize(16);
    doc.text('Home Loan Report', margin, y);
    y += 18;

    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y); y += 14;

    // summary fields (left side)
    const summaryX = margin;
    doc.text(`Principal: ${fmt(parseFloat($('principal').value || 0))}`, summaryX, y); y+=12;
    doc.text(`Loan Start: ${$('startDate').value || '—'}`, summaryX, y); y+=12;
    doc.text(`Tenure (months, baseline): ${window._last?.baseline?.monthsTaken || '—'}`, summaryX, y); y+=12;
    doc.text(`EMI (baseline): ${fmt(window._last?.baseline?.baseEmi || 0)}`, summaryX, y); y+=16;

    // Per-prepayment brief
    doc.setFontSize(11);
    doc.text('Per-prepayment savings (summary):', summaryX, y); y+=12;
    const perSavings = computePerPrepaySavings(
      window._last?.baseline?.rows?.[0]?.opening || parseFloat($('principal').value || 0),
      parseFloat($('initialRate').value || 0),
      (parseInt($('years').value||0)*12 + parseInt($('months').value||0)),
      window._last?.startDate || new Date(),
      window._last?.prepayments || [],
      window._last?.roiChanges || []
    );

    doc.setFontSize(9);
    if(perSavings.length === 0){
      doc.text('No prepayments defined.', summaryX, y); y+=12;
    } else {
      perSavings.forEach((s, idx) => {
        const p = s.prepay;
        const line = `Prepay ${idx+1}: ${p.date} - ${fmt(p.amount)} - ${p.strategy} | Interest saved: ${fmt(s.interestSaved)}, Months saved: ${s.monthsSaved}`;
        // Wrap text if necessary:
        const split = doc.splitTextToSize(line, pageWidth - margin*2);
        doc.text(split, summaryX, y);
        y += (split.length * 10) + 4;
        if(y > pageHeight - 220){ doc.addPage(); y = margin; }
      });
    }

    y += 6;

    // Insert chart image (fit to page width minus margins)
    const imgMaxWidth = pageWidth - margin*2;
    // preserve aspect ratio
    const img = new Image();
    img.src = imgData;
    await new Promise((res,rej)=>{
      img.onload = res;
      img.onerror = rej;
    });
    const imgW = img.width;
    const imgH = img.height;
    const scale = Math.min(1, imgMaxWidth / imgW);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    // if not enough space on current page for chart + some rows, add page
    if(y + drawH > pageHeight - 160){
      doc.addPage(); y = margin;
    }
    doc.addImage(imgData, 'PNG', margin, y, drawW, drawH);
    y += drawH + 12;

    // Amortization table (first 40 rows)
    doc.setFontSize(10);
    doc.text('Amortization table (first 40 rows):', margin, y); y += 12;
    doc.setFontSize(8);
    const tableColsX = [margin, margin+30, margin+95, margin+155, margin+230, margin+295, margin+360, margin+420, margin+480];
    // header
    const headers = ['M','Date','ROI','Opening','EMI','Interest','Principal','Prepay','Closing'];
    headers.forEach((h, idx) => { doc.text(h, tableColsX[idx], y); });
    y += 10;

    const rows = window._last.withPrepay.rows.slice(0,40);
    doc.setFontSize(7.5);
    rows.forEach(r=>{
      const vals = [
        String(r.month), ymd(r.date), (r.roi||0).toFixed(2),
        Number(r.opening).toFixed(2), Number(r.emi).toFixed(2), Number(r.interest).toFixed(2),
        Number(r.principal).toFixed(2), Number(r.prepay).toFixed(2), Number(r.closing).toFixed(2)
      ];
      vals.forEach((v, idx) => {
        doc.text(String(v), tableColsX[idx], y);
      });
      y += 9;
      if(y > pageHeight - 40){
        doc.addPage();
        y = margin;
      }
    });

    // Save
    doc.save('home_loan_report_with_chart.pdf');

  } catch(err){
    console.error(err);
    alert('Failed to export PDF with chart: ' + (err && err.message ? err.message : err));
  }
});

/* ---------- Print ---------- */
$('printReport').addEventListener('click', ()=> {
  if(!window._last){ alert('Run calculation first'); return; }
  // create a printable window
  const w = window.open('', '_blank');
  const rows = window._last.withPrepay.rows;
  const title = `<h2>Home Loan Report</h2>`;
  const summaryHtml = `<p>Principal: ${fmt(parseFloat($('principal').value || 0))} <br/>
    Start Date: ${$('startDate').value || '—'} <br/>
    EMI (baseline): ${fmt(window._last?.baseline?.baseEmi || 0)}</p>`;
  let table = `<table border="1" cellpadding="4" style="border-collapse:collapse;font-family:Arial;font-size:12px">
    <thead><tr><th>Month</th><th>Date</th><th>ROI%</th><th>Opening</th><th>EMI</th><th>Interest</th><th>Principal</th><th>Prepay</th><th>Closing</th></tr></thead><tbody>`;
  rows.forEach(r=>{
    table += `<tr>
      <td style="text-align:center">${r.month}</td>
      <td style="text-align:center">${ymd(r.date)}</td>
      <td>${(r.roi||0).toFixed(2)}</td>
      <td>${r.opening.toFixed(2)}</td>
      <td>${r.emi.toFixed(2)}</td>
      <td>${r.interest.toFixed(2)}</td>
      <td>${r.principal.toFixed(2)}</td>
      <td>${r.prepay.toFixed(2)}</td>
      <td>${r.closing.toFixed(2)}</td>
    </tr>`;
  });
  table += '</tbody></table>';
  // include chart as dataURL image inline if exists
  const canvas = $('compareChart');
  let chartHtml = '';
  try {
    if(canvas){
      const data = canvas.toDataURL('image/png');
      chartHtml = `<div><img src="${data}" style="max-width:100%;height:auto;margin:12px 0"></div>`;
    }
  } catch(e){ /* ignore if cross-origin issues */ }

  w.document.write(`<html><head><title>Loan Report</title></head><body>${title}${summaryHtml}${chartHtml}${table}</body></html>`);
  w.document.close();
  w.print();
});

/* ---------- Wire calculate button ---------- */
$('calculate').addEventListener('click', calculateAll);

/* ---------- Observe list containers to save on DOM changes ---------- */
const observerConfig = { childList: true, subtree: true, attributes: false };
const roiObserver = new MutationObserver(() => scheduleSave());
const prepayObserver = new MutationObserver(() => scheduleSave());
roiObserver.observe($('roiList'), observerConfig);
prepayObserver.observe($('prepayList'), observerConfig);

/* ---------- Initial state & Calculate ---------- */
window.addEventListener('load', ()=>{
  // default start date = today
  const today = new Date();
  if(!$('startDate').value) $('startDate').value = ymd(today);

  // try load
  const loaded = loadState();
  if(!loaded){
    // add initial ROI entry aligned to start date
    $('roiList').appendChild(createRoiElement({date: ymd(today), rate: parseFloat($('initialRate').value)||8.8}));
    // No default prepay to avoid accidental extra payments
  }

  // attach input listeners to save
  ['principal','years','months','startDate','initialRate'].forEach(id=>{
    const el = $(id);
    el.addEventListener('input', scheduleSave);
    el.addEventListener('change', scheduleSave);
  });

  calculateAll();
});



// Select all toggle buttons
const toggleButtons = document.querySelectorAll('.toggle-btn');

toggleButtons.forEach(button => {
  button.addEventListener('click', () => {
    // Remove 'active' class from all buttons
    toggleButtons.forEach(btn => btn.classList.remove('active'));
    
    // Add 'active' class to the clicked button
    button.classList.add('active');
  });
});



