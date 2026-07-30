const STORAGE_KEY = "designer-secretary-mobile-v1";
const SYNC_SETTINGS_KEY = "designer-secretary-sync-settings-v1";
const GIST_FILE = "designer-secretary-data.json";

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
let syncSettings = loadSyncSettings();
let tracker = {
  watchId: null,
  points: [],
  distance: 0
};
let pendingDelete = null;

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

function loadSyncSettings() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveSyncSettings() {
  localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(syncSettings));
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
      from: "",
      to: inferDestination(text),
      place: inferDestination(text),
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
  renderSyncSettings();
  renderReports();
}

function renderStats() {
  const openTasks = visible(db.tasks).filter(item => item.status !== "已完成").length;
  const pendingMoney = visible(db.expenses).filter(item => item.status !== "已收回").reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const month = today().slice(0, 7);
  const miles = visible(db.mileage).filter(item => item.date?.startsWith(month)).reduce((sum, item) => sum + Number(item.distance || 0), 0);
  $("#statProjects").textContent = visible(db.projects).length;
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
  const items = visible(db.projects).filter(item => `${item.customer}${item.name}${item.stage}${item.style}`.includes(q));
  $("#projectCards").innerHTML = items.map(item => `
    <article class="card">
      <h3>${esc(item.name)}</h3>
      <p class="meta">${esc(item.customer)} · ${esc(item.address || "未填写地址")}</p>
      <div class="chips"><span class="chip">${esc(item.stage || "未设阶段")}</span>${item.style ? `<span class="chip">${esc(item.style)}</span>` : ""}</div>
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="projects" data-delete-id="${item.id}" data-delete-title="${esc(item.name)}">删除</button></div>
    </article>
  `).join("") || empty("还没有项目");
}

function renderMoney() {
  $("#expenseCards").innerHTML = visible(db.expenses).map(item => `
    <article class="card">
      <h3>${money(item.amount)} · ${esc(item.purpose)}</h3>
      <p class="meta">${esc(item.customer)} · ${esc(item.plannedReturnDate || "未设收回日期")}</p>
      <div class="chips"><span class="chip">${esc(item.status)}</span></div>
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="expenses" data-delete-id="${item.id}" data-delete-title="${esc(item.purpose || "垫付款")}">删除</button></div>
    </article>
  `).join("") || empty("暂无垫付款");
}

function renderMiles() {
  $("#trackDistance").textContent = `${tracker.distance.toFixed(2)} km`;
  $("#trackPoints").textContent = tracker.points.length;
  $("#mileageCards").innerHTML = visible(db.mileage).map(item => `
    <article class="card">
      <h3>${Number(item.distance || 0)} 公里</h3>
      <p class="meta">${esc(item.customer)} · ${esc(item.reason)} · ${esc(item.date)}</p>
      <p class="meta">地点：${esc(item.place || item.to || "待补充地点")}</p>
      <div class="chips"><span class="chip">${item.reimbursed ? "已报销" : "未报销"}</span></div>
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="mileage" data-delete-id="${item.id}" data-delete-title="${esc(item.reason || "里程")}">删除</button></div>
    </article>
  `).join("") || empty("暂无里程记录");
}

function renderFiles() {
  $("#fileCards").innerHTML = visible(db.files).map(file => `
    <article class="card">
      <div class="thumb">${file.dataUrl?.startsWith("data:image") ? `<img src="${file.dataUrl}" alt="${esc(file.name)}">` : "文件"}</div>
      <h3>${esc(file.name)}</h3>
      <p class="meta">${esc(file.customer || "未指定客户")} · ${esc(file.date)}</p>
      ${file.url ? `<p class="meta"><a href="${esc(file.url)}" target="_blank" rel="noopener">打开文件</a></p>` : ""}
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="files" data-delete-id="${file.id}" data-delete-title="${esc(file.name)}">删除</button></div>
    </article>
  `).join("") || empty("还没有照片或文件");
}

function renderLogs() {
  $("#logCards").innerHTML = visible(db.logs).map(logCard).join("") || empty("暂无记录");
}

function renderReports() {
  if (!$("#dailyReport")) return;
  hydrateReportProjectSelect();
  $("#dailyReport").textContent = buildDailyReport(today());
  $("#projectReport").textContent = buildProjectReport($("#reportProjectSelect").value);
  $("#mileageReport").textContent = buildMileageReport();
}

function hydrateReportProjectSelect() {
  const select = $("#reportProjectSelect");
  const current = select.value;
  select.innerHTML = [
    `<option value="">全部项目</option>`,
    ...visible(db.projects).map(project => `<option value="${project.id}">${esc(project.customer)} - ${esc(project.name)}</option>`)
  ].join("");
  select.value = current;
}

function buildDailyReport(date) {
  const logs = visible(db.logs).filter(item => item.date === date);
  const tasks = visible(db.tasks).filter(item => item.status !== "已完成" && (item.date === date || item.createdAt?.startsWith(date) || /明天|明日|明早|明晚/.test(item.title || "")));
  const summary = logs.length ? logs.map(item => cleanReportText(item.text)).filter(Boolean).join("；") : "暂无";
  const tomorrow = tasks.length ? tasks.map(item => cleanReportText(item.title)).filter(Boolean).join("；") : "暂无";
  return [
    "姓名：缪梦豪",
    `日期：${formatChineseDate(date)}`,
    `今日总结：${summary}`,
    `明日工作：${tomorrow}`
  ].join("\n");
}

function cleanReportText(text) {
  return String(text || "")
    .replace(/^明天跟进：/, "")
    .replace(/^跟进整改\/修改：/, "")
    .replace(/^跟进垫付款收回$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。；;]+$/g, "");
}

function formatChineseDate(date) {
  const [, month, day] = String(date).match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) return date;
  return `${Number(month)}月${Number(day)}号`;
}

function buildProjectReport(projectId) {
  const projects = projectId ? visible(db.projects).filter(item => item.id === projectId) : visible(db.projects);
  if (!projects.length) return "暂无项目。";
  return projects.map(project => {
    const logs = visible(db.logs).filter(item => item.projectId === project.id);
    const tasks = visible(db.tasks).filter(item => item.projectId === project.id && item.status !== "已完成");
    const expenses = visible(db.expenses).filter(item => item.projectId === project.id && item.status !== "已收回");
    const mileage = visible(db.mileage).filter(item => item.projectId === project.id);
    const totalMiles = mileage.reduce((sum, item) => sum + Number(item.distance || 0), 0);
    const pendingMoney = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return [
      `项目：${project.name}`,
      `客户：${project.customer}`,
      `地址：${project.address || "待补充"}`,
      `当前阶段：${project.stage || "待补充"}`,
      `风格：${project.style || "待补充"}`,
      `工作记录：${logs.length} 条`,
      `未完成待办：${tasks.length} 个`,
      `项目里程：${totalMiles} 公里`,
      `待收垫付款：${money(pendingMoney)}`,
      "",
      "最近进展：",
      ...(logs.slice(0, 5).map(item => `- ${item.date} ${item.text}`).length ? logs.slice(0, 5).map(item => `- ${item.date} ${item.text}`) : ["- 暂无"]),
      "",
      "待办事项：",
      ...(tasks.length ? tasks.slice(0, 8).map(item => `- ${item.title}`) : ["- 暂无"])
    ].join("\n");
  }).join("\n\n----------------\n\n");
}

function buildMileageReport() {
  const miles = visible(db.mileage);
  const total = miles.reduce((sum, item) => sum + Number(item.distance || 0), 0);
  return [
    "里程记录",
    "",
    `合计：${total} 公里`,
    "",
    ...(miles.length ? miles.map(item => `${item.date || ""}｜${item.customer || "未指定客户"}｜${item.reason || "外出"}｜${item.place || item.to || "待补充地点"}｜${Number(item.distance || 0)}公里｜${item.reimbursed ? "已报销" : "未报销"}`) : ["暂无里程记录"])
  ].join("\n");
}

function projectLabel(projectId, fallbackCustomer = "") {
  const project = visible(db.projects).find(item => item.id === projectId);
  return project ? `${project.customer}-${project.name}` : fallbackCustomer;
}

function visible(items) {
  return (items || []).filter(item => !item.deletedAt);
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
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="logs" data-delete-id="${log.id}" data-delete-title="工作记录">删除</button></div>
    </article>
  `;
}

function empty(text) {
  return `<article class="card"><p class="meta">${text}</p></article>`;
}

function openForm(type) {
  const dialog = $("#formDialog");
  $("#dialogTitle").textContent = { project: "新建项目", expense: "记录垫付款", mileage: "记录里程" }[type];
  const projectOptions = visible(db.projects).map(p => `<option value="${p.id}">${esc(p.customer)} - ${esc(p.name)}</option>`).join("");
  $("#dialogFields").innerHTML = {
    project: `
      <label>客户姓名<input name="customer" placeholder="可先不填，例如：李女士"></label>
      <label>项目名称<input name="name" placeholder="可先写：临时出图项目"></label>
      <label>地址<input name="address" placeholder="小区/房号"></label>
      <label>阶段<input name="stage" placeholder="水电施工"></label>
      <label>风格<input name="style" placeholder="现代原木风"></label>
    `,
    expense: `
      <label>项目<select name="projectId">${projectOptions}</select></label>
      <label>金额<input name="amount" type="number" placeholder="680"></label>
      <label>用途<input name="purpose" placeholder="可后补，例如：瓷砖样品费"></label>
      <label>计划收回<input name="plannedReturnDate" placeholder="月底"></label>
    `,
    mileage: `
      <label>项目<select name="projectId">${projectOptions}</select></label>
      <label>事项<input name="reason" placeholder="可后补，例如：现场量房"></label>
      <label>里程<input name="distance" type="number" placeholder="38"></label>
      <label>去了哪里<input name="place" placeholder="例如：李女士家 / 建材市场"></label>
      <label>出发地<input name="from" placeholder="例如：工作室"></label>
      <label>目的地<input name="to" placeholder="例如：客户家"></label>
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
    const customer = String(form.get("customer") || "").trim() || "未知客户";
    const name = String(form.get("name") || "").trim() || `${customer}项目`;
    db.projects.unshift({
      id: id(),
      customer,
      name,
      address: form.get("address") || "",
      stage: form.get("stage") || "待补充",
      style: form.get("style") || "",
      createdAt: new Date().toISOString()
    });
  }
  if (type === "expense") {
    const project = db.projects.find(p => p.id === form.get("projectId"));
    db.expenses.unshift({
      id: id(),
      projectId: project?.id || "",
      customer: project?.customer || "未指定客户",
      amount: Number(form.get("amount") || 0),
      purpose: form.get("purpose") || "待补充用途",
      plannedReturnDate: form.get("plannedReturnDate") || "",
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
      reason: form.get("reason") || "待补充事项",
      distance: Number(form.get("distance") || 0),
      place: form.get("place") || form.get("to") || "待补充地点",
      from: form.get("from") || "",
      to: form.get("to") || form.get("place") || "",
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
  const blob = new Blob([JSON.stringify(withMeta(db), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `设计秘书备份-${today()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast(`${label}已复制`);
  }
}

function exportMileageCsv() {
  const miles = visible(db.mileage);
  const rows = [
    ["日期", "客户", "事项", "去了哪里", "出发地", "目的地", "里程", "报销状态"],
    ...miles.map(item => [
      item.date || "",
      item.customer || "未指定客户",
      item.reason || "外出",
      item.place || item.to || "待补充地点",
      item.from || "",
      item.to || "",
      Number(item.distance || 0),
      item.reimbursed ? "已报销" : "未报销"
    ])
  ];
  const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `里程记录-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = normalizeDb(JSON.parse(reader.result));
      db = mergeDb(db, incoming);
      save();
      render();
      toast("备份已导入并合并");
    } catch {
      toast("备份文件格式不对");
    }
  };
  reader.readAsText(file);
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
  const firstPoint = tracker.points[0];
  const lastPoint = tracker.points[tracker.points.length - 1];
  db.mileage.unshift({
    id: id(),
    projectId: "",
    customer: "自动记录",
    reason: "手机定位里程",
    distance: Number(tracker.distance.toFixed(2)),
    date: today(),
    place: trackerPlaceLabel(),
    from: firstPoint ? `${firstPoint.lat.toFixed(6)},${firstPoint.lng.toFixed(6)}` : "",
    to: lastPoint ? `${lastPoint.lat.toFixed(6)},${lastPoint.lng.toFixed(6)}` : "",
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

function trackerPlaceLabel() {
  const firstPoint = tracker.points[0];
  const lastPoint = tracker.points[tracker.points.length - 1];
  if (!firstPoint || !lastPoint) return "手机定位里程";
  return `从 ${firstPoint.lat.toFixed(4)},${firstPoint.lng.toFixed(4)} 到 ${lastPoint.lat.toFixed(4)},${lastPoint.lng.toFixed(4)}`;
}

function inferDestination(text) {
  const patterns = [
    /去(.{1,16}?)(?:，|。|,|\.|往返|来回|跑了|开车|$)/,
    /去了(.{1,16}?)(?:，|。|,|\.|往返|来回|跑了|开车|$)/,
    /到(.{1,16}?)(?:，|。|,|\.|往返|来回|跑了|开车|$)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return "";
}

function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 2200);
}

function renderSyncSettings() {
  const token = $("#syncToken");
  const gist = $("#syncGistId");
  if (!token || document.activeElement === token || document.activeElement === gist) return;
  token.value = syncSettings.token || "";
  gist.value = syncSettings.gistId || "";
}

function readSyncSettingsFromForm() {
  syncSettings.token = $("#syncToken").value.trim();
  syncSettings.gistId = $("#syncGistId").value.trim();
  saveSyncSettings();
  if (!syncSettings.token) throw new Error("请先填写 GitHub Token");
}

function syncPayload() {
  const copy = withMeta(db);
  copy.files = copy.files.map(file => ({
    ...file,
    dataUrl: file.dataUrl && file.dataUrl.length > 120000 ? "" : file.dataUrl,
    skippedLargeFile: Boolean(file.dataUrl && file.dataUrl.length > 120000)
  }));
  return copy;
}

function withMeta(value) {
  return {
    ...structuredClone(value),
    meta: {
      app: "designer-secretary",
      version: 1,
      exportedAt: new Date().toISOString()
    }
  };
}

function normalizeDb(value) {
  return {
    projects: Array.isArray(value.projects) ? value.projects : [],
    logs: Array.isArray(value.logs) ? value.logs : [],
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
    expenses: Array.isArray(value.expenses) ? value.expenses : [],
    mileage: Array.isArray(value.mileage) ? value.mileage : [],
    files: Array.isArray(value.files) ? value.files : []
  };
}

function mergeDb(local, incoming) {
  const result = structuredClone(base);
  for (const key of Object.keys(base)) {
    const map = new Map();
    for (const item of [...(incoming[key] || []), ...(local[key] || [])]) {
      if (!item.id) item.id = id();
      const old = map.get(item.id);
      if (!old || recordTime(item) > recordTime(old)) {
        map.set(item.id, item);
      }
    }
    result[key] = [...map.values()].sort((a, b) => recordTime(b).localeCompare(recordTime(a)));
  }
  return result;
}

function recordTime(item) {
  return String(item.updatedAt || item.deletedAt || item.createdAt || item.date || "");
}

function openDeleteDialog(type, itemId, title) {
  pendingDelete = { type, itemId, title };
  $("#deleteSummary").textContent = `要删除：${title || "这条记录"}`;
  const item = (db[type] || []).find(record => record.id === itemId);
  const canDeleteGithub = type === "files" && item && item.githubPath && item.githubSha;
  $("#deleteGithubBtn").disabled = !canDeleteGithub;
  $("#deleteGithubBtn").textContent = canDeleteGithub ? "删除 GitHub 仓库文件" : "此记录没有 GitHub 仓库文件";
  $("#deleteDialog").showModal();
}

function deleteCurrentDevice() {
  if (!pendingDelete) return;
  const projectId = pendingDelete.type === "projects" ? pendingDelete.itemId : "";
  db[pendingDelete.type] = (db[pendingDelete.type] || []).filter(item => item.id !== pendingDelete.itemId);
  if (projectId) {
    for (const key of ["logs", "tasks", "expenses", "mileage", "files"]) {
      db[key] = (db[key] || []).filter(item => item.projectId !== projectId);
    }
  }
  save();
  $("#deleteDialog").close();
  render();
  toast("已从当前设备删除");
}

function deleteEverywhere() {
  if (!pendingDelete) return;
  const item = (db[pendingDelete.type] || []).find(record => record.id === pendingDelete.itemId);
  if (!item) return;
  const deletedAt = new Date().toISOString();
  markDeleted(item, deletedAt);
  if (pendingDelete.type === "projects") {
    for (const key of ["logs", "tasks", "expenses", "mileage", "files"]) {
      for (const related of db[key] || []) {
        if (related.projectId === pendingDelete.itemId) markDeleted(related, deletedAt);
      }
    }
  }
  save();
  $("#deleteDialog").close();
  render();
  toast("已标记同步删除，其他设备同步后会消失");
}

function markDeleted(item, deletedAt) {
  item.deletedAt = deletedAt;
  item.updatedAt = deletedAt;
}

async function deleteGithubFile() {
  if (!pendingDelete) return;
  const item = (db[pendingDelete.type] || []).find(record => record.id === pendingDelete.itemId);
  if (!item || !item.githubPath || !item.githubSha) return toast("这条记录没有可删除的 GitHub 仓库文件");
  try {
    readSyncSettingsFromForm();
    const encodedPath = item.githubPath.split("/").map(encodeURIComponent).join("/");
    await githubRequest(`/repos/${item.githubOwner}/${item.githubRepo}/contents/${encodedPath}`, {
      method: "DELETE",
      body: JSON.stringify({
        message: `delete ${item.githubPath}`,
        sha: item.githubSha,
        branch: item.githubBranch || "main"
      })
    });
    item.githubDeletedAt = new Date().toISOString();
    item.deletedAt = item.githubDeletedAt;
    item.updatedAt = item.githubDeletedAt;
    save();
    $("#deleteDialog").close();
    render();
    toast("GitHub 仓库文件已删除");
  } catch (error) {
    toast(error.message);
  }
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${syncSettings.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "GitHub 同步失败");
  return data;
}

async function ensureGist() {
  if (syncSettings.gistId) return syncSettings.gistId;
  const gist = await githubRequest("/gists", {
    method: "POST",
    body: JSON.stringify({
      description: "设计秘书数据同步",
      public: false,
      files: {
        [GIST_FILE]: {
          content: JSON.stringify(syncPayload(), null, 2)
        }
      }
    })
  });
  syncSettings.gistId = gist.id;
  saveSyncSettings();
  $("#syncGistId").value = gist.id;
  return gist.id;
}

async function pushSync() {
  try {
    readSyncSettingsFromForm();
    $("#syncStatus").textContent = "正在上传到 GitHub Gist...";
    const gistId = await ensureGist();
    await githubRequest(`/gists/${gistId}`, {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          [GIST_FILE]: {
            content: JSON.stringify(syncPayload(), null, 2)
          }
        }
      })
    });
    $("#syncStatus").textContent = "已上传。电脑和手机用同一个 Token/Gist ID 就能下载。";
    toast("已上传到云端");
  } catch (error) {
    $("#syncStatus").textContent = error.message;
    toast(error.message);
  }
}

async function pullSync({ merge = true } = {}) {
  try {
    readSyncSettingsFromForm();
    if (!syncSettings.gistId) throw new Error("请填写 Gist ID，或先上传创建一个");
    $("#syncStatus").textContent = "正在从 GitHub Gist 下载...";
    const gist = await githubRequest(`/gists/${syncSettings.gistId}`);
    const content = gist.files?.[GIST_FILE]?.content;
    if (!content) throw new Error("这个 Gist 里没有设计秘书数据");
    const incoming = normalizeDb(JSON.parse(content));
    db = merge ? mergeDb(db, incoming) : incoming;
    save();
    render();
    $("#syncStatus").textContent = "已下载并合并。";
    toast("已从云端下载");
  } catch (error) {
    $("#syncStatus").textContent = error.message;
    toast(error.message);
  }
}

async function mergeSync() {
  await pullSync({ merge: true });
  await pushSync();
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
$("#dialogCloseBtn").addEventListener("click", () => $("#formDialog").close());
$("#projectSearch").addEventListener("input", renderProjects);
$("#fileInput").addEventListener("change", event => handleFile(event.target.files[0]));
$("#exportBtn").addEventListener("click", exportData);
$("#exportBtn2").addEventListener("click", exportData);
$("#importBtn").addEventListener("click", () => $("#importInput").click());
$("#importInput").addEventListener("change", event => importData(event.target.files[0]));
$("#pushSyncBtn").addEventListener("click", pushSync);
$("#pullSyncBtn").addEventListener("click", () => pullSync({ merge: true }));
$("#mergeSyncBtn").addEventListener("click", mergeSync);
document.addEventListener("click", event => {
  const button = event.target.closest("[data-delete-type]");
  if (!button) return;
  openDeleteDialog(button.dataset.deleteType, button.dataset.deleteId, button.dataset.deleteTitle);
});
$("#deleteCloseBtn").addEventListener("click", () => $("#deleteDialog").close());
$("#deleteLocalBtn").addEventListener("click", deleteCurrentDevice);
$("#deleteSyncBtn").addEventListener("click", deleteEverywhere);
$("#deleteGithubBtn").addEventListener("click", deleteGithubFile);
$("#reportProjectSelect").addEventListener("change", renderReports);
$("#copyDailyBtn").addEventListener("click", () => copyText($("#dailyReport").textContent, "日报"));
$("#copyProjectReportBtn").addEventListener("click", () => copyText($("#projectReport").textContent, "项目进度报告"));
$("#copyMileageBtn").addEventListener("click", () => copyText($("#mileageReport").textContent, "里程记录"));
$("#exportMileageCsvBtn").addEventListener("click", exportMileageCsv);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
render();
