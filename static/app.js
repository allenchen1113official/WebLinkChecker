/* WebLinkChecker — Frontend */
"use strict";

// ── State ──────────────────────────────────────────────────────────────────────
let currentJobId  = null;
let currentFilter = "broken";   // default: show broken only (like brokenlinkcheck.com)
let checkedUrl    = "";
let allResults    = [];          // full list; pushed as results stream in
let statsPages    = 0;

// ── DOM refs ───────────────────────────────────────────────────────────────────
const form          = document.getElementById("check-form");
const urlInput      = document.getElementById("url-input");
const submitBtn     = document.getElementById("submit-btn");
const btnLabel      = document.getElementById("btn-label");
const btnSpinner    = document.getElementById("btn-spinner");
const progressWrap  = document.getElementById("progress-wrap");
const resultsWrap   = document.getElementById("results-wrap");
const stopBtn       = document.getElementById("stop-btn");
const statusText    = document.getElementById("status-text");
const progTitle     = document.getElementById("prog-title");
const statPages     = document.getElementById("stat-pages");
const statTotal     = document.getElementById("stat-total");
const statBroken    = document.getElementById("stat-broken");
const statOk        = document.getElementById("stat-ok");
const sumTotal      = document.getElementById("sum-total");
const sumBroken     = document.getElementById("sum-broken");
const sumOk         = document.getElementById("sum-ok");
const sumPages      = document.getElementById("sum-pages");
const resBody       = document.getElementById("res-body");
const cntAll        = document.getElementById("cnt-all");
const cntBroken     = document.getElementById("cnt-broken");
const cntOk         = document.getElementById("cnt-ok");
const exportPdfBtn  = document.getElementById("export-pdf-btn");
const exportHtmlBtn = document.getElementById("export-html-btn");
const emptyNote     = document.getElementById("empty-note");
const tblFooter     = document.getElementById("tbl-footer");
const visibleCount  = document.getElementById("visible-count");

// ── Form submit ────────────────────────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  resetState();
  checkedUrl = url;
  setChecking(true);

  const payload = {
    url,
    timeout:  parseInt(document.getElementById("opt-timeout").value, 10)  || 15,
    delay:    parseFloat(document.getElementById("opt-delay").value)       || 0,
    maxPages: parseInt(document.getElementById("opt-maxpages").value, 10)  || 0,
  };

  let jobId;
  try {
    const res = await fetch("/check", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      showError(data.error || "伺服器錯誤，請重試");
      setChecking(false);
      return;
    }
    jobId = data.job_id;
    currentJobId = jobId;
  } catch (err) {
    showError("無法連線至伺服器：" + err.message);
    setChecking(false);
    return;
  }

  progressWrap.hidden = false;
  progressWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
  openSSE(jobId);
});

// ── SSE ────────────────────────────────────────────────────────────────────────
function openSSE(jobId) {
  const es = new EventSource(`/stream/${jobId}`);

  es.onmessage = ({ data: raw }) => {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case "status":
        statusText.textContent = msg.message;
        if (/^Crawling:/i.test(msg.message)) {
          statsPages++;
          statPages.textContent = statsPages;
          sumPages.textContent  = statsPages;
        }
        break;

      case "result":
        onResult(msg);
        break;

      case "summary":
        // Final authoritative counts
        statTotal.textContent  = msg.total;
        statBroken.textContent = msg.broken;
        statOk.textContent     = msg.ok;
        sumTotal.textContent   = msg.total;
        sumBroken.textContent  = msg.broken;
        sumOk.textContent      = msg.ok;
        refreshTabCounts();
        break;

      case "error":
        progTitle.textContent = "發生錯誤";
        statusText.textContent = "錯誤：" + msg.message;
        break;

      case "done":
        es.close();
        onDone();
        break;
    }
  };

  es.onerror = () => { es.close(); if (currentJobId === jobId) onDone(); };
}

// ── Handle one result ──────────────────────────────────────────────────────────
function onResult(r) {
  allResults.push(r);

  const broken  = allResults.filter(x => x.is_broken).length;
  const ok      = allResults.length - broken;

  statTotal.textContent  = allResults.length;
  statBroken.textContent = broken;
  statOk.textContent     = ok;
  sumTotal.textContent   = allResults.length;
  sumBroken.textContent  = broken;
  sumOk.textContent      = ok;
  refreshTabCounts();

  resultsWrap.hidden = false;
  appendRow(r, allResults.length);
  applyFilter();
}

// ── Append a <tr> ──────────────────────────────────────────────────────────────
function appendRow(r, rowNum) {
  const tr = document.createElement("tr");
  tr.dataset.broken = r.is_broken ? "1" : "0";
  if (r.is_broken) tr.classList.add("row-broken");

  // #
  const tdNo = document.createElement("td");
  tdNo.className = "col-no";
  tdNo.style.textAlign = "center";
  tdNo.style.color = "var(--gray-400)";
  tdNo.textContent = rowNum;

  // Status badge
  const tdSt = document.createElement("td");
  tdSt.innerHTML = `<span class="badge ${badgeCls(r)}">${esc(r.status_label)}</span>`;

  // URL
  const tdUrl = document.createElement("td");
  tdUrl.innerHTML = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>`;

  // Found on
  const tdFound = document.createElement("td");
  if (r.found_on && r.found_on.length > 0) {
    const extra = r.found_on.length - 1;
    tdFound.innerHTML =
      `<ul class="found-links"><li><a href="${esc(r.found_on[0])}" target="_blank" rel="noopener">${esc(r.found_on[0])}</a></li></ul>` +
      (extra > 0 ? `<div class="found-more">…及另外 ${extra} 個頁面</div>` : "");
  } else {
    tdFound.innerHTML = `<span style="color:var(--gray-400);font-size:.8rem">起始頁</span>`;
  }

  tr.append(tdNo, tdSt, tdUrl, tdFound);
  resBody.appendChild(tr);
}

// ── Filter ─────────────────────────────────────────────────────────────────────
document.getElementById("filter-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".ftab");
  if (!tab) return;
  document.querySelectorAll(".ftab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");
  currentFilter = tab.dataset.filter;
  applyFilter();
});

function applyFilter() {
  let visible = 0;
  resBody.querySelectorAll("tr").forEach((tr) => {
    const broken = tr.dataset.broken === "1";
    let show = true;
    if (currentFilter === "broken") show = broken;
    if (currentFilter === "ok")     show = !broken;
    tr.hidden = !show;
    if (show) visible++;
  });
  emptyNote.hidden  = visible > 0;
  tblFooter.hidden  = visible === 0;
  visibleCount.textContent = `顯示 ${visible} 筆`;
}

function refreshTabCounts() {
  const total  = allResults.length;
  const broken = allResults.filter(r => r.is_broken).length;
  const ok     = total - broken;
  cntAll.textContent    = total;
  cntBroken.textContent = broken;
  cntOk.textContent     = ok;
}

// ── Done ───────────────────────────────────────────────────────────────────────
function onDone() {
  setChecking(false);
  progTitle.textContent = "檢查完成 ✓";
  document.querySelector(".pulse-dot").style.cssText =
    "animation:none;background:var(--green)";
  stopBtn.hidden = true;
  exportPdfBtn.disabled  = false;
  exportHtmlBtn.disabled = false;
}

// ── Stop ───────────────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  stopBtn.disabled = true;
  await fetch(`/cancel/${currentJobId}`, { method: "POST" }).catch(() => {});
  statusText.textContent = "使用者已停止";
});

// ── PDF Export ─────────────────────────────────────────────────────────────────
exportPdfBtn.addEventListener("click", () => {
  if (!window.jspdf) {
    alert("PDF 函式庫尚未載入，請確認網路連線後重新整理頁面。");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const filtered = getFiltered();
  const date     = new Date().toLocaleString("zh-TW");
  const broken   = allResults.filter(r => r.is_broken).length;
  const ok       = allResults.length - broken;
  const filterLabel = { all: "All Links", broken: "Broken Only", ok: "OK Only" }[currentFilter];

  // ── Header band
  doc.setFillColor(21, 88, 214);
  doc.rect(0, 0, 297, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont(undefined, "bold");
  doc.text("WebLinkChecker — Broken Link Report", 12, 14);

  // ── Meta info
  doc.setTextColor(60, 60, 60);
  doc.setFont(undefined, "normal");
  doc.setFontSize(8.5);
  const urlText = checkedUrl.length > 90 ? checkedUrl.slice(0, 87) + "..." : checkedUrl;
  doc.text(`URL: ${urlText}`, 12, 30);
  doc.text(`Generated: ${date}`, 12, 36);
  doc.text(
    `Total: ${allResults.length}    Broken: ${broken}    OK: ${ok}    Filter: ${filterLabel}`,
    12, 42
  );

  // ── Table
  const rows = filtered.map((r, i) => [
    i + 1,
    r.status_label,
    r.url.length > 80 ? r.url.slice(0, 77) + "..." : r.url,
    r.found_on.length > 0
      ? (r.found_on[0].length > 70 ? r.found_on[0].slice(0, 67) + "..." : r.found_on[0])
      : "(start URL)",
  ]);

  doc.autoTable({
    head: [["#", "Status", "URL", "Found On (First Source)"]],
    body: rows,
    startY: 48,
    theme: "grid",
    styles: { fontSize: 7.5, cellPadding: 2.5, overflow: "linebreak" },
    headStyles: {
      fillColor: [21, 88, 214],
      textColor: 255,
      fontStyle: "bold",
      fontSize: 8,
    },
    columnStyles: {
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: 25, halign: "center" },
      2: { cellWidth: 130 },
      3: { cellWidth: 112 },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const r = filtered[data.row.index];
      if (!r) return;
      if (r.is_broken) {
        data.cell.styles.fillColor = [255, 236, 235];
        data.cell.styles.textColor = [168, 30, 30];
      }
    },
    didDrawPage: (data) => {
      // Page number footer
      const pageCount = doc.getNumberOfPages();
      doc.setFontSize(7);
      doc.setTextColor(150, 150, 150);
      doc.text(
        `Page ${data.pageNumber} / ${pageCount}`,
        doc.internal.pageSize.getWidth() - 20,
        doc.internal.pageSize.getHeight() - 6
      );
    },
  });

  const filename = `link-report-${iso8601date()}.pdf`;
  doc.save(filename);
});

// ── HTML Export ────────────────────────────────────────────────────────────────
exportHtmlBtn.addEventListener("click", () => {
  const filtered   = getFiltered();
  const date       = new Date().toLocaleString("zh-TW");
  const broken     = allResults.filter(r => r.is_broken).length;
  const ok         = allResults.length - broken;
  const filterLabel = { all: "全部連結", broken: "僅失效連結", ok: "僅正常連結" }[currentFilter];

  const rows = filtered.map((r, i) => {
    const rowCls  = r.is_broken ? "broken" : "ok";
    const bdgBg   = r.is_broken ? "#fdecea" : "#e6f4ea";
    const bdgClr  = r.is_broken ? "#c0392b" : "#1a7a40";
    const bdgBdr  = r.is_broken ? "#f4b8b5" : "#a8d5b5";
    const foundHtml = r.found_on.length > 0
      ? r.found_on.map(f => `<a href="${esc(f)}">${esc(f)}</a>`).join("<br>")
      : "<em>起始頁</em>";
    return `<tr class="${rowCls}">
      <td class="tc">${i + 1}</td>
      <td><span class="bdg" style="background:${bdgBg};color:${bdgClr};border-color:${bdgBdr}">${esc(r.status_label)}</span></td>
      <td><a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a></td>
      <td>${foundHtml}</td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WebLinkChecker 報告 — ${esc(checkedUrl)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
     background:#f1f5f9;color:#0f172a;font-size:14px;line-height:1.6}
a{color:#1558d6;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px}
/* header */
.rpt-header{background:linear-gradient(135deg,#0d3da8,#1a6cdf);color:#fff;
            border-radius:10px;padding:24px 28px;margin-bottom:20px}
.rpt-header h1{font-size:1.3rem;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.rpt-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px;
          font-size:.82rem;opacity:.88}
.rpt-meta span b{font-weight:700}
/* summary */
.stats{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.stat{background:#fff;border-radius:8px;padding:14px 20px;box-shadow:0 1px 4px rgba(0,0,0,.08);
      flex:1;min-width:110px;text-align:center}
.stat .n{font-size:1.9rem;font-weight:900;line-height:1.1}
.stat .l{font-size:.72rem;color:#475569;margin-top:3px;font-weight:500}
.n-total{color:#0f172a}.n-broken{color:#c0392b}.n-ok{color:#1a7a40}.n-pages{color:#1558d6}
/* table */
.tbl-wrap{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse;font-size:.85rem}
thead tr{background:#e8f0fe;border-bottom:2px solid #b6ccfe}
th{padding:10px 14px;text-align:left;font-size:.72rem;font-weight:700;
   color:#1558d6;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td{padding:9px 14px;border-bottom:1px solid #f1f5f9;vertical-align:top;word-break:break-all}
tr:last-child td{border-bottom:none}
tr.broken td{background:#fffaf9}tr.broken:hover td{background:#fdecea}
tr.ok:hover td{background:#f8fafc}
.tc{text-align:center;color:#94a3b8;width:42px}
.bdg{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.72rem;
     font-weight:700;border:1px solid transparent}
/* footer */
.rpt-foot{margin-top:20px;text-align:center;font-size:.78rem;color:#94a3b8}
@media(max-width:600px){th:last-child,td:last-child{display:none}}
@media print{body{background:#fff}.rpt-header{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body>
<div class="wrap">

  <div class="rpt-header">
    <h1>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      WebLinkChecker 報告
    </h1>
    <div class="rpt-meta">
      <span>&#x1F310; <b>檢查網址：</b>${esc(checkedUrl)}</span>
      <span>&#x1F4C5; <b>產生時間：</b>${date}</span>
      <span>&#x1F50D; <b>篩選：</b>${filterLabel}</span>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="n n-total">${allResults.length}</div><div class="l">總連結數</div></div>
    <div class="stat"><div class="n n-broken">${broken}</div><div class="l">失效連結</div></div>
    <div class="stat"><div class="n n-ok">${ok}</div><div class="l">正常連結</div></div>
    <div class="stat"><div class="n n-pages">${statsPages}</div><div class="l">已爬頁面</div></div>
  </div>

  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th class="tc">#</th>
          <th>狀態碼</th>
          <th>連結網址</th>
          <th>發現於（來源頁面）</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>

  <div class="rpt-foot">由 WebLinkChecker 自動產生 &mdash; ${date}</div>
</div>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const a    = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = `link-report-${iso8601date()}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function getFiltered() {
  if (currentFilter === "broken") return allResults.filter(r => r.is_broken);
  if (currentFilter === "ok")     return allResults.filter(r => !r.is_broken);
  return allResults;
}

function badgeCls(r) {
  if (r.error || !r.status_code) return "berr";
  const s = r.status_code;
  if (s >= 500) return "b5xx";
  if (s >= 400) return "b4xx";
  if (s >= 300) return "b3xx";
  return "b2xx";
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function iso8601date() {
  return new Date().toISOString().slice(0, 10);
}

function setChecking(active) {
  submitBtn.disabled      = active;
  exportPdfBtn.disabled   = true;
  exportHtmlBtn.disabled  = true;
  btnLabel.textContent    = active ? "檢查中…" : "開始檢查";
  btnSpinner.hidden       = !active;
}

function showError(msg) {
  alert(msg);
}

function resetState() {
  allResults    = [];
  statsPages    = 0;
  currentFilter = "broken";
  currentJobId  = null;

  resBody.innerHTML   = "";
  progressWrap.hidden = true;
  resultsWrap.hidden  = true;
  emptyNote.hidden    = true;
  tblFooter.hidden    = true;
  stopBtn.hidden      = false;
  stopBtn.disabled    = false;

  [statPages, statTotal, statBroken, statOk,
   sumTotal, sumBroken, sumOk, sumPages].forEach(el => { el.textContent = "0"; });
  [cntAll, cntBroken, cntOk].forEach(el => { el.textContent = "0"; });

  progTitle.textContent = "正在檢查中…";
  const dot = document.querySelector(".pulse-dot");
  if (dot) dot.style.cssText = "";

  // Reset active tab to "broken"
  document.querySelectorAll(".ftab").forEach(t => t.classList.remove("active"));
  const brokenTab = document.querySelector('[data-filter="broken"]');
  if (brokenTab) brokenTab.classList.add("active");
}
