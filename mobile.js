const STORAGE_KEY = "designer-secretary-mobile-v1";

const base = {
  projects: [],
  logs: [],
  tasks: [],
  expenses: [],
  mileage: [],
  files: []
};

let db = load();
let currentTab = "home";
let tracker = {
  watchId: null,
  points: [],
  distance: 0
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const id = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const money = value => `¥${Number(value || 0).toLocaleString("zh-CN")}`;

function load() {
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
  } catch {
    return structuredClone(base);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function parseText(text) {
  const now = new Date().toISOString();
  const customerMatch = text.match(/([\u4e00-\u9fa5]{1,4})(女士|先生|姐|哥|总)/);
  const customer = customerMatch ? `${customerMatch[1]}${customerMatch[2]}` : "未指定客户";
  let project = db.projects.find(item => text.includes(item.customer) || text.includes(item.name));
  if (!project && customer !== "未指定客户") {
    project = {
      id: id(),
      customer,
      name: `${customer}住宅项目`,
      address: "",
      stage: inferStage(text) || "需求沟通",
      style: "",
      createdAt: now
    };
    db.projects.unshift(project);
  }

  const stage = inferStage(text);
  const space = inferSpace(text);
  db.logs.unshift({
    id: id(),
    projectId: project?.id || "",
    customer,
    text,
    stage,
    space,
    date: today(),
    createdAt: now
  });

  const mile = text.match(/(\d+(?:\.\d+)?)\s*(公里|km|KM)/);
  if (mile) {
    db.mileage.unshift({
      id: id(),
      projectId: project?.id || "",
      customer,
      date: today(),
      reason: stage || "外出记录",
      distance: Number(mile[1]),
      reimbursed: false,
      note: text,
      createdAt: now
    });
  }

  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*元/g)) {
    db.expenses.unshift({
      id: id(),
      projectId: project?.id || "",
      customer,
      date: today(),
      amount: Number(match[1]),
      purpose: inferPurpose(text),
      plannedReturnDate: text.includes("月底") ? "月底" : "",
      status: "待收回",
      note: text,
      createdAt: now
    });
  }

  if (/明天|提醒|修改|整改|复查|确认|收/.test(text)) {
    db.tasks.unshift({
      id: id(),
      projectId: project?.id || "",
      customer,
      title: text.includes("元") ? "跟进垫付款收回" : text.slice(0, 48),
      status: "未完成",
      date: today(),
      createdAt: now
    });
  }

  if (project && stage) project.stage = stage;
  save();
}

function inferStage(text) {
  const stages = ["量房", "平面", "效果图", "施工图", "报价", "合同", "材料", "水电", "泥瓦", "木工", "油漆", "定制", "软装", "验收"];
  const hit = stages.find(stage => text.includes(stage));
  const map = { 量房: "现场量房", 平面: "平面方案", 水电: "水电施工", 木工: "木工施工", 油漆: "油漆施工", 验收: "完工验收" };
  return hit ? (map[hit] || hit) : "";
}

function inferSpace(text) {
  return ["厨房", "客厅", "餐厅", "主卧", "次卧", "儿童房", "书房", "卫生间", "阳台", "入户"].find(space => text.includes(space)) || "";
}

function inferPurpose(text) {
  return ["灯具定金", "瓷砖样品费", "瓷砖补货", "五金", "材料", "运费"].find(item => text.includes(item)) || "客户垫付款";
}

function setTab(tab) {
  currentTab = tab;
  $$(".screen").forEach(screen => screen.classList.remove("active"));
  $(`#${tab}Screen`).classList.add("active");
  $$(".tabs button").forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
  render();
}

function render() {
  renderStats();
  renderRecent();
  renderProjects();
  renderMoney();
  renderMiles();
  renderFiles();
  renderLogs();
}

function renderStats() {
  const openTasks = db.tasks.filter(item => item.status !== "已完成").length;
  const pendingMoney = db.expenses.filter(item => item.status !== "已收回").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const month = today().slice(0, 7);
  const miles = db.mileage.filter(item => item.date?.startsWith(month)).reduce((sum, item) => sum + Number(item.distance || 0), 0);
  $("#statProjects").textContent = db.projects.length;
  $("#statTasks").textContent = openTasks;
  $("#statMoney").textContent = money(pendingMoney);
  $("#statMiles").textContent = miles;
  $("#todayLine").textContent = `${today()} · ${openTasks} 个待办 · 待收 ${money(pendingMoney)}`;
}

function renderRecent() {
  $("#recentFeed").innerHTML = db.logs.slice(0, 5).map(logCard).join("") || empty("还没有记录，先说一句今天做了什么。");
}

function renderProjects() {
  const q = ($("#projectSearch")?.value || "").trim();
  const items = db.projects.filter(item => `${item.customer}${item.name}${item.stage}${item.style}`.includes(q));
  $("#projectCards").innerHTML = items.map(item => `
    <article class="card">
      <h3>${esc(item.name)}</h3>
      <p class="meta">${esc(item.customer)} · ${esc(item.address || "未填写地址")}</p>
      <div class="chips"><span class="chip">${esc(item.stage || "未设阶段")}</span>${item.style ? `<span class="chip">${esc(item.style)}</span>` : ""}</div>
    </article>
  `).join("") || empty("还没有项目");
}

function renderMoney() {
  $("#expenseCards").innerHTML = db.expenses.map(item => `
    <article class="card">
      <h3>${money(item.amount)} · ${esc(item.purpose)}</h3>
      <p class="meta">${esc(item.customer)} · ${esc(item.plannedReturnDate || "未设收回日期")}</p>
      <div class="chips"><span class="chip">${esc(item.status)}</span></div>
    </article>
  `).join("") || empty("暂无垫付款");
}

function renderMiles() {
  $("#trackDistance").textContent = `${tracker.distance.toFixed(2)} km`;
  $("#trackPoints").textContent = tracker.points.length;
  $("#mileageCards").innerHTML = db.mileage.map(item => `
    <article class="card">
      <h3>${Number(item.distance || 0)} 公里</h3>
      <p class="meta">${esc(item.customer)} · ${esc(item.reason)} · ${esc(item.date)}</p>
      <div class="chips"><span class="chip">${item.reimbursed ? "已报销" : "未报销"}</span></div>
    </article>
  `).join("") || empty("暂无里程记录");
}

function renderFiles() {
  $("#fileCards").innerHTML = db.files.map(file => `
    <article class="card">
      <div class="thumb">${file.dataUrl?.startsWith("data:image") ? `<img src="${file.dataUrl}" alt="${esc(file.name)}">` : "文件"}</div>
      <h3>${esc(file.name)}</h3>
      <p class="meta">${esc(file.customer || "未指定客户")} · ${esc(file.date)}</p>
    </article>
  `).join("") || empty("还没有照片或文件");
}

function renderLogs() {
  $("#logCards").innerHTML = db.logs.map(logCard).join("") || empty("暂无记录");
}

function logCard(log) {
  return `
    <article class="card">
      <h3>${esc(log.customer || "工作记录")}</h3>
      <p>${esc(log.text)}</p>
      <div class="chips">
        <span class="chip">${esc(log.date)}</span>
        ${log.stage ? `<span class="chip">${esc(log.stage)}</span>` : ""}
        ${log.space ? `<span class="chip">${esc(log.space)}</span>` : ""}
      </div>
    </article>
  `;
}

function empty(text) {
  return `<article class="card"><p class="meta">${text}</p></article>`;
}

function openForm(type) {
  const dialog = $("#formDialog");
  $("#dialogTitle").textContent = { project: "新建项目", expense: "记录垫付款", mileage: "记录里程" }[type];
  const projectOptions = db.projects.map(p => `<option value="${p.id}">${esc(p.customer)} - ${esc(p.name)}</option>`).join("");
  $("#dialogFields").innerHTML = {
    project: `
      <label>客户姓名<input name="customer" required placeholder="李女士"></label>
      <label>项目名称<input name="name" placeholder="李女士住宅项目"></label>
      <label>地址<input name="address" placeholder="小区/房号"></label>
      <label>阶段<input name="stage" placeholder="水电施工"></label>
      <label>风格<input name="style" placeholder="现代原木风"></label>
    `,
    expense: `
      <label>项目<select name="projectId">${projectOptions}</select></label>
      <label>金额<input name="amount" type="number" required placeholder="680"></label>
      <label>用途<input name="purpose" required placeholder="瓷砖样品费"></label>
      <label>计划收回<input name="plannedReturnDate" placeholder="月底"></label>
    `,
    mileage: `
      <label>项目<select name="projectId">${projectOptions}</select></label>
      <label>事项<input name="reason" required placeholder="现场量房"></label>
      <label>里程<input name="distance" type="number" required placeholder="38"></label>
      <label>日期<input name="date" type="date" value="${today()}"></label>
    `
  }[type];
  $("#dialogForm").dataset.type = type;
  dialog.showModal();
}

function submitForm(event) {
  event.preventDefault();
  const type = $("#dialogForm").dataset.type;
  const form = new FormData($("#dialogForm"));
  if (type === "project") {
    const customer = form.get("customer");
    db.projects.unshift({
      id: id(),
      customer,
      name: form.get("name") || `${customer}住宅项目`,
      address: form.get("address"),
      stage: form.get("stage") || "需求沟通",
      style: form.get("style"),
      createdAt: new Date().toISOString()
    });
  }
  if (type === "expense") {
    const project = db.projects.find(p => p.id === form.get("projectId"));
    db.expenses.unshift({
      id: id(),
      projectId: project?.id || "",
      customer: project?.customer || "未指定客户",
      amount: Number(form.get("amount")),
      purpose: form.get("purpose"),
      plannedReturnDate: form.get("plannedReturnDate"),
      status: "待收回",
      date: today(),
      createdAt: new Date().toISOString()
    });
  }
  if (type === "mileage") {
    const project = db.projects.find(p => p.id === form.get("projectId"));
    db.mileage.unshift({
      id: id(),
      projectId: project?.id || "",
      customer: project?.customer || "未指定客户",
      reason: form.get("reason"),
      distance: Number(form.get("distance")),
      date: form.get("date") || today(),
      reimbursed: false,
      createdAt: new Date().toISOString()
    });
  }
  save();
  $("#formDialog").close();
  render();
  toast("已保存");
}

function startVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return toast("这个浏览器暂不支持语音识别，请先用文字。");
  const recognition = new Recognition();
  recognition.lang = "zh-CN";
  recognition.onresult = event => {
    $("#quickText").value = [$("#quickText").value, event.results[0][0].transcript].join(" ").trim();
    toast("已转成文字，可修改后保存");
  };
  recognition.start();
}

function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `设计秘书备份-${today()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    db.files.unshift({
      id: id(),
      name: file.name,
      type: file.type,
      dataUrl: reader.result,
      date: today(),
      createdAt: new Date().toISOString()
    });
    save();
    render();
    toast("照片/文件已保存");
  };
  reader.readAsDataURL(file);
}

function startTracking() {
  if (!navigator.geolocation) return toast("当前浏览器不支持定位。");
  if (tracker.watchId) return toast("已经在记录里程");
  tracker.points = [];
  tracker.distance = 0;
  $("#trackStatus").textContent = "正在定位，请保持页面打开。iPhone 锁屏或切到后台后可能暂停。";
  tracker.watchId = navigator.geolocation.watchPosition(position => {
    const point = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      time: Date.now()
    };
    if (point.accuracy > 80) {
      $("#trackStatus").textContent = "定位精度较低，正在等待更准确的位置。";
      return;
    }
    const last = tracker.points[tracker.points.length - 1];
    if (last) {
      const meters = distanceMeters(last, point);
      if (meters >= 8 && meters <= 2000) tracker.distance += meters / 1000;
    }
    tracker.points.push(point);
    $("#trackStatus").textContent = "正在记录本次外出里程。";
    renderMiles();
  }, error => {
    $("#trackStatus").textContent = "定位失败，请检查 Safari 定位权限。";
    toast(error.message || "定位失败");
  }, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000
  });
}

function stopTracking() {
  if (!tracker.watchId) return toast("还没有开始记录");
  navigator.geolocation.clearWatch(tracker.watchId);
  tracker.watchId = null;
  if (tracker.distance <= 0) {
    $("#trackStatus").textContent = "本次没有形成有效里程。";
    renderMiles();
    return;
  }
  db.mileage.unshift({
    id: id(),
    projectId: "",
    customer: "自动记录",
    reason: "手机定位里程",
    distance: Number(tracker.distance.toFixed(2)),
    date: today(),
    reimbursed: false,
    points: tracker.points,
    createdAt: new Date().toISOString()
  });
  save();
  $("#trackStatus").textContent = "已保存本次自动里程。";
  tracker.points = [];
  tracker.distance = 0;
  render();
  toast("自动里程已保存");
}

function distanceMeters(a, b) {
  const radius = 6371000;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 2200);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

$$("[data-tab]").forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));
$("#saveQuickBtn").addEventListener("click", () => {
  const text = $("#quickText").value.trim();
  if (!text) return toast("先写一句要记录的内容");
  parseText(text);
  $("#quickText").value = "";
  render();
  toast("已自动整理");
});
$("#voiceBtn").addEventListener("click", startVoice);
$("#addProjectBtn").addEventListener("click", () => openForm("project"));
$("#addExpenseBtn").addEventListener("click", () => openForm("expense"));
$("#addMileageBtn").addEventListener("click", () => openForm("mileage"));
$("#startTrackBtn").addEventListener("click", startTracking);
$("#stopTrackBtn").addEventListener("click", stopTracking);
$("#dialogForm").addEventListener("submit", submitForm);
$("#projectSearch").addEventListener("input", renderProjects);
$("#fileInput").addEventListener("change", event => handleFile(event.target.files[0]));
$("#exportBtn").addEventListener("click", exportData);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
render();
