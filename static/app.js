/* WebLinkChecker — Frontend */
"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
let currentJobId = null;
let currentFilter = "all";
let allResults   = [];   // [{url, status_code, error, is_broken, status_label, found_on}]
let statsPages   = 0;
let statsTotal   = 0;
let statsBroken  = 0;
let statsOk      = 0;

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const form           = document.getElementById("check-form");
const urlInput       = document.getElementById("url-input");
const submitBtn      = document.getElementById("submit-btn");
const btnLabel       = document.getElementById("btn-label");
const btnSpinner     = document.getElementById("btn-spinner");
const progressSec    = document.getElementById("progress-section");
const resultsSec     = document.getElementById("results-section");
const stopBtn        = document.getElementById("stop-btn");
const statusText     = document.getElementById("status-text");
const progressTitle  = document.getElementById("progress-title");
const statPages      = document.getElementById("stat-pages");
const statTotal      = document.getElementById("stat-total");
const statBroken     = document.getElementById("stat-broken");
const statOk         = document.getElementById("stat-ok");
const resultsBody    = document.getElementById("results-body");
const countAll       = document.getElementById("count-all");
const countBroken    = document.getElementById("count-broken");
const countOk        = document.getElementById("count-ok");
const exportBtn      = document.getElementById("export-btn");
const summaryBanner  = document.getElementById("summary-banner");
const summaryText    = document.getElementById("summary-text");
const emptyMsg       = document.getElementById("empty-msg");

// ─── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  resetState();
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
      alert(data.error || "發生錯誤，請重試");
      setChecking(false);
      return;
    }
    jobId = data.job_id;
    currentJobId = jobId;
  } catch (err) {
    alert("無法連線至伺服器：" + err.message);
    setChecking(false);
    return;
  }

  progressSec.hidden = false;
  progressSec.scrollIntoView({ behavior: "smooth", block: "start" });

  listenStream(jobId);
});

// ─── SSE stream ───────────────────────────────────────────────────────────────
function listenStream(jobId) {
  const es = new EventSource(`/stream/${jobId}`);

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === "status") {
      statusText.textContent = msg.message;

      // Count crawled pages heuristically from status messages
      if (msg.message.startsWith("Crawling:")) {
        statsPages++;
        statPages.textContent = statsPages;
      }

    } else if (msg.type === "result") {
      handleResult(msg);

    } else if (msg.type === "summary") {
      // Final counts come from summary; update display
      statTotal.textContent  = msg.total;
      statBroken.textContent = msg.broken;
      statOk.textContent     = msg.ok;
      updateTabCounts();

    } else if (msg.type === "error") {
      statusText.textContent = "錯誤：" + msg.message;
      progressTitle.textContent = "檢查失敗";

    } else if (msg.type === "done") {
      es.close();
      onDone();
    }
  };

  es.onerror = () => {
    es.close();
    if (currentJobId === jobId) {
      onDone();
    }
  };
}

// ─── Handle a single result event ─────────────────────────────────────────────
function handleResult(r) {
  allResults.push(r);
  statsTotal++;
  if (r.is_broken) {
    statsBroken++;
  } else {
    statsOk++;
  }

  statTotal.textContent  = statsTotal;
  statBroken.textContent = statsBroken;
  statOk.textContent     = statsOk;
  updateTabCounts();

  resultsSec.hidden = false;
  appendRow(r);
  applyFilter();
}

// ─── Append table row ─────────────────────────────────────────────────────────
function appendRow(r) {
  const tr = document.createElement("tr");
  tr.dataset.broken = r.is_broken ? "1" : "0";
  if (r.is_broken) tr.classList.add("row-broken");

  // Status badge
  const tdStatus = document.createElement("td");
  tdStatus.innerHTML = `<span class="badge ${badgeClass(r)}">${escHtml(r.status_label)}</span>`;

  // URL
  const tdUrl = document.createElement("td");
  tdUrl.innerHTML = `<a href="${escHtml(r.url)}" target="_blank" rel="noopener">${escHtml(r.url)}</a>`;

  // Found on
  const tdFound = document.createElement("td");
  if (r.found_on && r.found_on.length > 0) {
    const first = r.found_on[0];
    const extra = r.found_on.length - 1;
    tdFound.innerHTML =
      `<ul class="found-list"><li><a href="${escHtml(first)}" target="_blank" rel="noopener">${escHtml(first)}</a></li></ul>` +
      (extra > 0 ? `<div class="found-more">…及另外 ${extra} 個頁面</div>` : "");
  } else {
    tdFound.innerHTML = `<span style="color:var(--gray-400);font-size:.8rem">起始頁</span>`;
  }

  tr.appendChild(tdStatus);
  tr.appendChild(tdUrl);
  tr.appendChild(tdFound);
  resultsBody.appendChild(tr);
}

// ─── Filter ───────────────────────────────────────────────────────────────────
document.getElementById("filter-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".filter-tab");
  if (!tab) return;
  document.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");
  currentFilter = tab.dataset.filter;
  applyFilter();
});

function applyFilter() {
  let visible = 0;
  resultsBody.querySelectorAll("tr").forEach((tr) => {
    const broken = tr.dataset.broken === "1";
    let show = true;
    if (currentFilter === "broken") show = broken;
    if (currentFilter === "ok")     show = !broken;
    tr.hidden = !show;
    if (show) visible++;
  });
  emptyMsg.hidden = visible > 0;
}

function updateTabCounts() {
  const total  = allResults.length;
  const broken = allResults.filter(r => r.is_broken).length;
  const ok     = total - broken;
  countAll.textContent    = total;
  countBroken.textContent = broken;
  countOk.textContent     = ok;
}

// ─── Done ─────────────────────────────────────────────────────────────────────
function onDone() {
  setChecking(false);
  progressTitle.textContent = "檢查完成";
  document.querySelector(".progress-dot").style.animation = "none";
  document.querySelector(".progress-dot").style.background = "var(--success)";
  stopBtn.hidden = true;

  const broken = allResults.filter(r => r.is_broken).length;
  summaryText.innerHTML =
    `共檢查 <strong>${allResults.length}</strong> 個連結 ─ ` +
    `<strong style="color:var(--danger-light)">${broken}</strong> 個失效 ─ ` +
    `<strong style="color:#86efac">${allResults.length - broken}</strong> 個正常`;
  summaryBanner.hidden = false;
}

// ─── Stop ─────────────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  await fetch(`/cancel/${currentJobId}`, { method: "POST" });
  stopBtn.disabled = true;
  statusText.textContent = "使用者已停止檢查";
});

// ─── Export CSV ───────────────────────────────────────────────────────────────
exportBtn.addEventListener("click", () => {
  const rows = [["URL", "Status", "Error", "Broken", "Found On"]];
  allResults.forEach(r => {
    rows.push([
      r.url,
      r.status_code ?? "",
      r.error ?? "",
      r.is_broken ? "TRUE" : "FALSE",
      (r.found_on || []).join(" | "),
    ]);
  });
  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "link-check-report.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function badgeClass(r) {
  if (r.error || !r.status_code)   return "badge-err";
  const s = r.status_code;
  if (s >= 500) return "badge-5xx";
  if (s >= 400) return "badge-4xx";
  if (s >= 300) return "badge-3xx";
  return "badge-2xx";
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setChecking(active) {
  submitBtn.disabled = active;
  btnLabel.textContent = active ? "檢查中…" : "開始檢查";
  btnSpinner.hidden = !active;
}

function resetState() {
  allResults   = [];
  statsPages   = 0;
  statsTotal   = 0;
  statsBroken  = 0;
  statsOk      = 0;
  currentFilter = "all";
  currentJobId  = null;

  resultsBody.innerHTML = "";
  progressSec.hidden    = true;
  resultsSec.hidden     = true;
  summaryBanner.hidden  = true;
  emptyMsg.hidden       = true;
  stopBtn.hidden        = false;
  stopBtn.disabled      = false;

  statPages.textContent  = "0";
  statTotal.textContent  = "0";
  statBroken.textContent = "0";
  statOk.textContent     = "0";
  countAll.textContent    = "0";
  countBroken.textContent = "0";
  countOk.textContent     = "0";

  progressTitle.textContent = "正在檢查中…";
  document.querySelector(".progress-dot").style.animation = "";
  document.querySelector(".progress-dot").style.background = "";

  document.querySelectorAll(".filter-tab").forEach(t => t.classList.remove("active"));
  document.querySelector('[data-filter="all"]').classList.add("active");
}
