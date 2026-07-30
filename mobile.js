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
let pendingReschedule = null;
let selectedUploadFile = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const id = () => crypto.randomUUID();
const today = () => new Date().toISOString().slice(0, 10);
const money = value => `¥${Number(value || 0).toLocaleString("zh-CN")}`;

function load() {
  try {
    const repaired = repairLoadedData({ ...base, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(repaired));
    return repaired;
  } catch {
    return structuredClone(base);
  }
}

function save() {
  db = repairLoadedData(db);
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
  if (/今日总结：|明日工作：/.test(text)) return parseStructuredReport(text, now);
  const workItems = extractWorkItems(text);
  if (workItems.length > 1) return parseWorkItems(text, workItems, now);
  const projectMentions = extractProjectMentions(text);
  if (projectMentions.length > 1) return parseMultiProjectText(text, projectMentions, now);
  const customer = inferCustomer(text);
  let project = findProjectFromText(text, customer, projectMentions[0]?.name || "");
  const result = { project: "", task: "", mileage: "", expense: "", stage: "" };
  if (!project && (customer !== "未指定客户" || projectMentions[0])) project = ensureProject(customer, projectMentions[0]?.name || "", text, now);
  if (project) result.project = project.name || project.customer;

  const stage = inferStage(text);
  const space = inferSpace(text);
  if (!isAdminReminder(text)) {
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
  }
  if (stage) result.stage = stage;

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
    result.mileage = `${mile[1]}公里`;
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
      dueDate: normalizeReminderDate(text.includes("月底") ? "月底" : inferDateText(text)),
      status: "待收回",
      note: text,
      createdAt: now
    });
    result.expense = `${money(Number(match[1]))} ${inferPurpose(text)}`;
  }

  if (shouldCreateTask(text)) {
    const reminder = parseReminderDateTime(text);
    const title = inferTaskTitle(text);
    db.tasks.unshift({
      id: id(),
      projectId: project?.id || "",
      customer,
      title,
      status: "未完成",
      date: reminder.date,
      dueDate: reminder.date,
      dueTime: reminder.time,
      sourceText: text,
      createdAt: now
    });
    result.task = `${title}（${reminder.date} ${reminder.time}）`;
  }

  if (project && stage) {
    project.stage = stage;
    project.stageUpdatedAt = now;
    project.nextActionDate = predictProjectNextDate(project);
    project.updatedAt = now;
  }
  save();
  return result;
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

function inferCustomer(text) {
  const value = String(text || "").replace(/(今天|今日|昨天|昨日|明天|明日|上午|下午|晚上|早上|中午)/g, "");
  const match = value.match(/(?:去|到|去了|对接|跟进|拜访|联系)?\s*([\u4e00-\u9fa5]{1,3})(女士|先生|姐|哥|总)/);
  return match ? cleanCustomerName(`${match[1]}${match[2]}`) : "未指定客户";
}

function cleanCustomerName(value) {
  return cleanNamePrefix(value).replace(/住宅项目$|项目$/g, "").trim();
}

function repairLoadedData(value) {
  const copy = { ...base, ...value };
  copy.projects = (copy.projects || []).map(project => {
    const customer = cleanCustomerName(project.customer || "");
    const cleanedName = cleanProjectName(project.name || "", customer);
    const addressParts = inferAddressParts(`${cleanedName} ${project.address || ""}`);
    return {
      ...project,
      customer: customer || project.customer,
      name: cleanedName || project.name,
      community: project.community || addressParts.community,
      unitNo: project.unitNo || addressParts.unitNo,
      deadline: normalizeReminderDate(project.deadline || "")
    };
  });
  for (const key of ["logs", "tasks", "expenses", "mileage", "files"]) {
    copy[key] = (copy[key] || []).map(item => ({
      ...item,
      customer: cleanCustomerName(item.customer || "") || item.customer,
      projectName: item.projectName ? cleanProjectName(item.projectName, item.customer) : item.projectName
    }));
  }
  copy.logs = (copy.logs || []).map(item => isAdminReminder(item.text) ? { ...item, deletedAt: item.deletedAt || new Date().toISOString() } : item);
  splitLegacyMultiProjectTasks(copy);
  return copy;
}

function splitLegacyMultiProjectTasks(copy) {
  const additions = [];
  for (const task of copy.tasks || []) {
    if (task.deletedAt) continue;
    const mentions = extractProjectMentions(`${task.title || ""} ${task.sourceText || ""}`);
    if (mentions.length < 2) continue;
    const deletedAt = new Date().toISOString();
    task.deletedAt = deletedAt;
    task.updatedAt = deletedAt;
    for (const mention of mentions) {
      let project = (copy.projects || []).find(item => item.name === mention.name);
      if (!project) {
        project = {
          id: id(),
          customer: "未指定客户",
          name: mention.name,
          address: "",
          stage: "需求沟通",
          style: "",
          createdAt: task.createdAt || deletedAt,
          stageUpdatedAt: task.createdAt || deletedAt,
          updatedAt: deletedAt
        };
        project.nextActionDate = predictProjectNextDate(project);
        copy.projects.unshift(project);
      }
      const source = extractSegmentForProject(task.title || task.sourceText || "", mention.name);
      additions.push({
        ...task,
        id: id(),
        projectId: project.id,
        customer: project.customer,
        title: inferProjectTaskTitle(source, mention.name),
        sourceText: source,
        deletedAt: "",
        updatedAt: deletedAt
      });
    }
  }
  if (additions.length) copy.tasks = [...additions, ...(copy.tasks || [])];
}

function cleanNamePrefix(value) {
  let text = String(value || "").trim();
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(/^(今天|今日|昨天|昨日|明天|明日|上午|下午|晚上|早上|中午|刚刚|现在)/, "")
      .replace(/^(去|到|去了|来到|前往|对接|跟进|拜访|联系|约了|见了|跑了)/, "")
      .replace(/^(.{0,3}?)(去|到)(?=[\u4e00-\u9fa5]{1,3}(女士|先生|姐|哥|总))/, "")
      .trim();
  }
  return text;
}

function cleanProjectName(name, customer = "") {
  let text = cleanNamePrefix(name);
  const cleanedCustomer = cleanCustomerName(customer);
  const customerHit = text.match(/([\u4e00-\u9fa5]{1,3})(女士|先生|姐|哥|总)/);
  if (customerHit && /^.*?(今天|今日|去|到|去了)/.test(text)) {
    text = `${customerHit[1]}${customerHit[2]}${text.slice(customerHit.index + customerHit[0].length)}`;
  }
  if (cleanedCustomer && !text.includes(cleanedCustomer) && /住宅项目|项目/.test(text)) {
    text = `${cleanedCustomer}住宅项目`;
  }
  return text || (cleanedCustomer ? `${cleanedCustomer}住宅项目` : "");
}

function inferAddressParts(text) {
  const value = String(text || "");
  const match = value.match(/([\u4e00-\u9fa5A-Za-z]{2,12})\s*(\d{1,2}[-－]\d{3,4})/);
  if (!match) return { community: "", unitNo: "" };
  return {
    community: match[1].replace(/^(今天|今日|去|到|去了)/, ""),
    unitNo: match[2].replace("－", "-")
  };
}

function inferDateText(text) {
  const value = String(text || "");
  const patterns = [
    /\d{4}-\d{1,2}-\d{1,2}/,
    /\d{1,2}\s*月\s*\d{1,2}\s*(号|日)?/,
    /\d{1,2}\s*(号|日)/,
    /\d+\s*天后/,
    /\d*\s*(周|星期|礼拜)后/,
    /下周[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]/,
    /下班前|下班|今晚|今天晚上|明早|明天早上|早上|上午|中午|下午|晚上|今天|今日|明天|明日|后天|月底|月末/
  ];
  return patterns.map(pattern => value.match(pattern)?.[0]).find(Boolean) || "";
}

function inferDeadlineText(text) {
  const value = String(text || "");
  const match = value.match(/(?:交期|交付|交图|提交|出图|完成|截止|最晚|月底|月末)[^\d一二三四五六日天周星期礼拜]*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*(?:号|日)?|\d{1,2}\s*(?:号|日)|下周[一二三四五六日天]|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|月底|月末|明天|明日|后天)?/);
  return match?.[1] || (/月底|月末/.test(value) ? "月底" : "");
}

function parseMultiProjectText(text, mentions, now = new Date().toISOString()) {
  const reminder = parseReminderDateTime(text);
  const result = { project: "", task: "", mileage: "", expense: "", stage: "" };
  const handled = [];
  for (const mention of mentions) {
    const sentence = extractSegmentForProject(text, mention.name);
    const project = ensureProject("未指定客户", mention.name, sentence, now);
    const stage = inferStage(sentence);
    const title = inferProjectTaskTitle(sentence, mention.name);
    db.logs.unshift({
      id: id(),
      projectId: project.id,
      customer: project.customer,
      text: sentence,
      stage,
      space: inferSpace(sentence),
      date: today(),
      createdAt: now
    });
    db.tasks.unshift({
      id: id(),
      projectId: project.id,
      customer: project.customer,
      title,
      status: "未完成",
      date: reminder.date,
      dueDate: reminder.date,
      dueTime: reminder.time,
      sourceText: sentence,
      createdAt: now
    });
    if (stage) {
      project.stage = stage;
      project.stageUpdatedAt = now;
      project.nextActionDate = predictProjectNextDate(project);
      project.updatedAt = now;
    }
    handled.push(`${project.name}：${title}`);
  }
  save();
  result.project = mentions.map(item => item.name).join("、");
  result.task = handled.join("；");
  return result;
}

function parseWorkItems(text, items, now = new Date().toISOString()) {
  const reminder = parseReminderDateTime(text);
  const result = { project: "", task: "", mileage: "", expense: "", stage: "" };
  const handled = [];
  for (const item of items) {
    const projectName = item.projectName || item.community || "临时项目";
    const project = ensureProject("未指定客户", projectName, item.text, now);
    const stage = inferStage(item.text);
    const title = inferProjectTaskTitle(item.text, projectName);
    db.logs.unshift({
      id: id(),
      projectId: project.id,
      customer: project.customer,
      text: item.text,
      stage,
      space: inferSpace(item.text),
      date: today(),
      createdAt: now
    });
    if (shouldCreateTask(item.text) || stage || item.action) {
      db.tasks.unshift({
        id: id(),
        projectId: project.id,
        customer: project.customer,
        title,
        status: "未完成",
        date: reminder.date,
        dueDate: reminder.date,
        dueTime: reminder.time,
        sourceText: item.text,
        createdAt: now
      });
      handled.push(`${projectDisplayName(project)}：${title}`);
    }
    if (stage) {
      project.stage = stage;
      project.stageUpdatedAt = now;
      project.nextActionDate = predictProjectNextDate(project);
      project.updatedAt = now;
    }
  }
  save();
  result.project = items.map(item => item.projectName || item.community).filter(Boolean).join("、");
  result.task = handled.join("；");
  return result;
}

function parseStructuredReport(text, now = new Date().toISOString()) {
  const reportDate = parseReportDate(text) || today();
  const summaryText = extractSection(text, "今日总结", "明日工作");
  const tomorrowText = extractSection(text, "明日工作", "");
  const summaryItems = extractWorkItems(summaryText, { requireMultiple: false });
  const tomorrowItems = extractWorkItems(tomorrowText, { requireMultiple: false });
  const result = { project: "", task: "", mileage: "", expense: "", stage: "" };
  const projects = new Set();
  const tasks = [];

  for (const item of summaryItems) {
    const project = ensureProject("未指定客户", item.projectName || item.community || "临时项目", item.text, now);
    const stage = inferStage(item.text);
    db.logs.unshift({
      id: id(),
      projectId: project.id,
      customer: project.customer,
      text: item.text,
      stage,
      space: inferSpace(item.text),
      date: reportDate,
      createdAt: now
    });
    if (stage) {
      project.stage = stage;
      project.stageUpdatedAt = now;
      project.nextActionDate = predictProjectNextDate(project);
      project.updatedAt = now;
    }
    projects.add(projectDisplayName(project));
  }

  for (const item of tomorrowItems) {
    const project = ensureProject("未指定客户", item.projectName || item.community || "临时项目", item.text, now);
    const title = inferProjectTaskTitle(item.text, item.projectName || item.community || project.name);
    db.tasks.unshift({
      id: id(),
      projectId: project.id,
      customer: project.customer,
      title,
      status: "未完成",
      date: addDays(reportDate, 1),
      dueDate: addDays(reportDate, 1),
      dueTime: inferTime(item.text, addDays(reportDate, 1)),
      sourceText: item.text,
      createdAt: now
    });
    projects.add(projectDisplayName(project));
    tasks.push(`${projectDisplayName(project)}：${title}`);
  }

  save();
  result.project = [...projects].join("、");
  result.task = tasks.join("；");
  return result;
}

function extractSection(text, startLabel, endLabel) {
  const value = String(text || "");
  const start = value.indexOf(`${startLabel}：`);
  if (start < 0) return "";
  const bodyStart = start + startLabel.length + 1;
  const end = endLabel ? value.indexOf(`${endLabel}：`, bodyStart) : -1;
  return (end >= 0 ? value.slice(bodyStart, end) : value.slice(bodyStart)).trim();
}

function parseReportDate(text) {
  const value = String(text || "");
  const match = value.match(/日期：\s*(?:(\d{4})[-年])?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:号|日)?/);
  if (!match) return "";
  const year = Number(match[1] || new Date().getFullYear());
  return dateFromParts(year, Number(match[2]), Number(match[3]));
}

function ensureProject(customer, projectName, text = "", now = new Date().toISOString()) {
  const cleanProject = cleanProjectName(projectName || "", customer);
  const addressParts = inferAddressParts(`${cleanProject} ${text}`);
  const cleanCustomer = customer !== "未指定客户" ? cleanCustomerName(customer) : inferCustomer(text);
  let project = findProjectFromText(text, cleanCustomer, cleanProject);
  if (project) return project;
  const name = cleanProject || (cleanCustomer !== "未指定客户" ? `${cleanCustomer}住宅项目` : "临时项目");
  project = {
    id: id(),
    customer: cleanCustomer || "未指定客户",
    name,
    community: addressParts.community,
    unitNo: addressParts.unitNo,
    address: [addressParts.community, addressParts.unitNo].filter(Boolean).join(" "),
    deadline: normalizeReminderDate(inferDeadlineText(text)),
    stage: inferStage(text) || "需求沟通",
    style: "",
    createdAt: now,
    stageUpdatedAt: now,
    updatedAt: now
  };
  project.nextActionDate = predictProjectNextDate(project);
  db.projects.unshift(project);
  return project;
}

function extractWorkItems(text, options = {}) {
  const requireMultiple = options.requireMultiple !== false;
  const source = String(text || "")
    .replace(/姓名：.*?(?=日期：|今日总结：|明日工作：|$)/g, "")
    .replace(/日期：.*?(?=今日总结：|明日工作：|$)/g, "")
    .replace(/今日总结：|明日工作：/g, "；");
  const parts = source.split(/[；;\n。]+/).map(part => part.trim()).filter(Boolean);
  const items = parts.map(part => {
    const mention = extractProjectMentions(part)[0];
    const communityOnly = extractCommunityOnly(part);
    const projectName = mention?.name || communityOnly;
    return {
      text: part,
      projectName,
      community: projectName ? inferAddressParts(projectName).community || projectName : "",
      action: cleanActionText(part, projectName)
    };
  }).filter(item => item.projectName || /修改|渲染|对接|报价|模型|方案|效果图|施工图|现场|量房|交付|提交/.test(item.text));
  return !requireMultiple || items.length > 1 ? items : [];
}

function extractCommunityOnly(text) {
  const value = String(text || "").replace(/^(今天|今日|明天|明日|上午|下午|晚上|工作|对接|跟进)[:：\s]*/, "");
  const match = value.match(/^([\u4e00-\u9fa5A-Za-z]{2,12}?)(?=(现场|模型|方案|报价|效果图|施工图|硬装|软装|部分|客户|量房|对接|修改|渲染|材料|合同|软装|定制))/);
  return match ? match[1] : "";
}

function cleanActionText(text, projectName = "") {
  return String(text || "").replace(projectName || "", "").replace(/^[，,。；;：:\s]+/, "").trim();
}

function extractProjectMentions(text) {
  const value = String(text || "");
  const pattern = /([\u4e00-\u9fa5A-Za-z]{2,12}\s*\d{1,2}[-－]\d{3,4})/g;
  return [...new Set([...value.matchAll(pattern)].map(match => match[1].replace(/\s+/g, "")))]
    .map(name => ({ name }));
}

function extractSegmentForProject(text, projectName) {
  const value = String(text || "");
  const start = value.indexOf(projectName);
  if (start < 0) return value;
  const next = value.slice(start + projectName.length).search(/[；;。]/);
  return next >= 0 ? value.slice(start, start + projectName.length + next) : value.slice(start);
}

function inferProjectTaskTitle(text, projectName = "") {
  let value = String(text || "").replace(projectName, "").replace(/^[，,。；;：:\s]+/, "").trim();
  value = value.replace(/^(方案|报价|效果图|硬装|模型|施工图)?/, match => match || "");
  return polishTaskTitle(value || `${projectName}项目跟进`);
}

function findProjectFromText(text, customer = "", projectName = "") {
  const value = String(text || "");
  const projects = visible(db.projects);
  return projects.find(item => [projectName, item.customer, item.name, item.address]
    .filter(Boolean)
    .some(key => value.includes(key) || item.name === key))
    || (customer && customer !== "未指定客户" ? projects.find(item => item.customer === customer) : null);
}

function shouldCreateTask(text) {
  return /待办|提醒|需要|要|记得|别忘|下班前|下班|今晚|上午|中午|下午|晚上|明天|明日|后天|跟进|修改|整改|复查|确认|收款|收回|报价|对接/.test(String(text || ""));
}

function isAdminReminder(text) {
  const value = String(text || "");
  return /提醒|记得|别忘|下班前|今晚|明天|明日|今天/.test(value)
    && /交日报|提交日报|日报|日总结|每日总结/.test(value)
    && !/(项目|方案|报价|效果图|施工图|现场|模型|渲染|量房|水电|硬装|软装|客户)/.test(value);
}

function inferTaskTitle(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.includes("元") && /收|报销|垫付/.test(value)) return "跟进垫付款收回";
  const match = value.match(/(?:提醒我|记得|别忘了?|需要|要|下班前|下班|今晚|今天晚上|上午|中午|下午|晚上|明天|明日|后天)(.{2,70})/);
  return polishTaskTitle((match ? match[1] : value).replace(/^[，,。；;：:\s]+/, ""));
}

function polishTaskTitle(text) {
  let value = String(text || "")
    .replace(/^(前|后|之前|以后)/, "")
    .replace(/项目对接$/, "项目对接")
    .replace(/^(交|提交)(日报|日总结|每日总结)$/, "提交日报")
    .replace(/^日报$/, "提交日报")
    .replace(/报价$/, "跟进报价确认")
    .replace(/效果图$/, "跟进效果图确认")
    .replace(/方案$/, "跟进方案确认")
    .trim();
  if (/日报/.test(value) && !/^提交/.test(value)) value = "提交日报";
  if (/收款|收回|要钱/.test(value)) value = "跟进款项收回";
  if (/方案修改|报价修改|硬装修改|效果图修改/.test(value)) value = value.replace(/、/g, "，");
  return value.slice(0, 60) || "跟进事项";
}

function buildInsight(result) {
  const parts = [];
  if (result.project) parts.push(`项目：${result.project}`);
  if (result.stage) parts.push(`阶段：${result.stage}`);
  if (result.task) parts.push(`待办：${result.task}`);
  if (result.mileage) parts.push(`里程：${result.mileage}`);
  if (result.expense) parts.push(`垫付：${result.expense}`);
  return parts.length ? `已整理：${parts.join("；")}` : "已保存为工作记录，暂未识别到项目或待办。";
}

function inferTimeLabel(text, date = today()) {
  const value = String(text || "");
  const time = inferTime(value, date);
  if (/下班前|下班/.test(value)) return `下班前 ${time}`;
  if (time) return `提醒时间 ${time}`;
  return "";
}

function inferTime(text, date = today()) {
  const value = String(text || "");
  const explicit = value.match(/([01]?\d|2[0-3])[:：点时](\d{1,2})?/);
  if (explicit) {
    let hour = Number(explicit[1]);
    if (/下午|晚上|今晚|下班/.test(value) && hour < 12) hour += 12;
    return `${String(hour).padStart(2, "0")}:${String(explicit[2] || "00").padStart(2, "0")}`;
  }
  const chineseHour = value.match(/([一二三四五六七八九十两]{1,3})点(?:半|(\d{1,2})分?)?/);
  if (chineseHour) {
    const hour = chineseNumberToHour(chineseHour[1], /下午|晚上|今晚|下班/.test(value));
    const minute = chineseHour[0].includes("半") ? "30" : String(chineseHour[2] || "00").padStart(2, "0");
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  if (/下班前|下班/.test(value)) return closingTime(date);
  if (/今晚|今天晚上|晚上/.test(value)) return "19:00";
  if (/明早|明天早上|早上/.test(value)) return "09:30";
  if (/上午/.test(value)) return "10:00";
  if (/中午/.test(value)) return "12:00";
  if (/下午/.test(value)) return "15:00";
  return isWorkday(date) ? "09:30" : "10:00";
}

function parseReminderDateTime(text) {
  const date = normalizeReminderDate(inferDateText(text)) || today();
  return { date, time: inferTime(text, date) };
}

function closingTime(date = today()) {
  const parsed = new Date(`${date}T00:00:00`);
  const isWeekend = !isWorkday(date);
  const isSummer = parsed.getMonth() >= 4 && parsed.getMonth() <= 8;
  if (isSummer) return isWeekend ? "18:00" : "17:30";
  return isWeekend ? "17:30" : "17:00";
}

function isWorkday(date = today()) {
  const parsed = new Date(`${date}T00:00:00`);
  return ![0, 6].includes(parsed.getDay());
}

function sortTimeFromLabel(label) {
  const match = String(label || "").match(/(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "23:59";
}

function currentMinute() {
  const now = new Date();
  return `${now.toISOString().slice(0, 10)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function chineseNumberToHour(value, afternoon = false) {
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  let hour = value === "十" ? 10 : value.startsWith("十") ? 10 + (map[value[1]] || 0) : value.endsWith("十") ? (map[value[0]] || 1) * 10 : value.includes("十") ? (map[value[0]] || 1) * 10 + (map[value[2]] || 0) : map[value] || 9;
  if (afternoon && hour < 12) hour += 12;
  return Math.min(hour, 23);
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
  renderReminders();
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
  $("#recentFeed").innerHTML = visible(db.logs).filter(item => !isAdminReminder(item.text)).slice(0, 5).map(logCard).join("") || empty("还没有记录，先说一句今天做了什么。");
}

function clearRecentLogs() {
  const logs = visible(db.logs);
  if (!logs.length) return toast("最近记录已经是空的");
  if (!confirm("确定清空所有工作记录吗？项目、待办、垫付、里程和照片不会删除。")) return;
  const deletedAt = new Date().toISOString();
  for (const log of logs) markDeleted(log, deletedAt);
  save();
  render();
  toast("最近记录已清空");
}

function renderReminders() {
  if (!$("#todayReminders")) return;
  const reminders = buildReminders();
  $("#reminderSummary").textContent = reminders.length ? `${reminders.length} 条要看` : "今天暂时清爽";
  $("#todayReminders").innerHTML = reminders.slice(0, 8).map(item => `
    <article class="card reminder-card">
      <div class="timeline-row">
        <strong class="timeline-time">${esc(item.time || "待定")}</strong>
        ${item.action ? `<button class="check-action" data-complete-kind="${esc(item.kind)}" data-complete-id="${esc(item.id)}" aria-label="${esc(item.action)}">✓</button>` : "<span></span>"}
        <div>
          <h3>${esc(item.title)}</h3>
          <p class="meta">${esc(item.detail)}</p>
          <div class="chips"><span class="chip">${esc(item.action ? `勾选${item.action}` : item.type)}</span>${item.date ? `<span class="chip">${esc(item.date)}</span>` : ""}</div>
          ${item.action ? `<div class="card-actions"><button class="mini-action reschedule-action" data-reschedule-kind="${esc(item.kind)}" data-reschedule-id="${esc(item.id)}" data-reschedule-title="${esc(item.title)}">改期</button></div>` : ""}
        </div>
      </div>
    </article>
  `).join("") || empty("今天没有到期提醒。");
}

function buildReminders() {
  const todayDate = today();
  const next3 = addDays(todayDate, 3);
  const reminders = [];
  for (const task of visible(db.tasks).filter(item => item.status !== "已完成")) {
    const date = normalizeReminderDate(task.dueDate || task.date || "");
    const time = task.dueTime || inferTime(task.sourceText || task.title || "", date || todayDate);
    const timeLabel = time ? `提醒时间 ${time}` : inferTimeLabel(task.sourceText || task.title || "", date || todayDate);
    const dueAt = `${date || todayDate} ${time || sortTimeFromLabel(timeLabel)}`;
    const isOverdue = dueAt < currentMinute();
    if (!date || date <= next3) {
      reminders.push({
        type: isOverdue ? "已到点" : "待办",
        title: task.title || "待办事项",
        detail: [projectLabel(task.projectId, task.customer || "未指定项目"), timeLabel].filter(Boolean).join(" · "),
        date: date || "未设日期",
        time: time || sortTimeFromLabel(timeLabel),
        kind: "task",
        id: task.id,
        action: "完成",
        sort: dueAt
      });
    }
  }
  for (const project of visible(db.projects)) {
    const nextDate = project.nextActionDate || predictProjectNextDate(project);
    if (nextDate && nextDate <= next3) {
      const prediction = stagePrediction(project.stage);
      const nextTime = project.nextActionTime || "09:30";
      reminders.push({
        type: nextDate < todayDate ? "阶段逾期" : "阶段预判",
        title: `${project.name || project.customer}：${prediction.next || "跟进下一步"}`,
        detail: `当前阶段：${project.stage || "待补充"}。${prediction.note}`,
        date: nextDate,
        time: nextTime,
        kind: "project",
        id: project.id,
        action: "已跟进",
        sort: `${nextDate} ${nextTime}`
      });
    }
  }
  for (const expense of visible(db.expenses).filter(item => item.status !== "已收回")) {
    const dueDate = normalizeReminderDate(expense.dueDate || expense.plannedReturnDate || "");
    if (dueDate && dueDate <= next3) {
      const dueTime = expense.dueTime || "15:00";
      reminders.push({
        type: dueDate < todayDate ? "逾期待收" : "待收款",
        title: `${expense.customer || "未指定客户"} 待收 ${money(expense.amount)}`,
        detail: expense.purpose || "垫付款",
        date: dueDate,
        time: dueTime,
        kind: "expense",
        id: expense.id,
        action: "已收回",
        sort: `${dueDate} ${dueTime}`
      });
    }
  }
  for (const row of receivableSummary()) {
    reminders.push({
      type: "应收统计",
      title: `${row.customer} 合计待收 ${money(row.total)}`,
      detail: `${row.count} 笔未收`,
      date: "",
      time: "统计",
      sort: "9999-12-31"
    });
  }
  return reminders.sort((a, b) => a.sort.localeCompare(b.sort));
}

function renderProjects() {
  hydrateCommunityFilter();
  const q = ($("#projectSearch")?.value || "").trim();
  const community = $("#communityFilter")?.value || "";
  const deadline = $("#deadlineFilter")?.value || "";
  const items = visible(db.projects)
    .filter(item => `${item.community}${item.unitNo}${item.customer}${item.name}${item.stage}${item.style}${item.address}`.includes(q))
    .filter(item => !community || item.community === community)
    .filter(item => matchDeadlineFilter(item.deadline, deadline));
  $("#projectCards").innerHTML = items.map(item => `
    <article class="card">
      <h3>${esc(item.name)}</h3>
      <p class="meta">${esc(item.community || "未填小区")} · ${esc(item.unitNo || "未填门牌")} · ${esc(item.customer || "未指定客户")}</p>
      <p class="meta">交期：${esc(item.deadline || "未设置")} · 下次提醒：${esc(item.nextActionDate || predictProjectNextDate(item) || "未设置")}</p>
      <div class="chips"><span class="chip">${esc(item.stage || "未设阶段")}</span>${item.style ? `<span class="chip">${esc(item.style)}</span>` : ""}</div>
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="projects" data-delete-id="${item.id}" data-delete-title="${esc(item.name)}">删除</button></div>
    </article>
  `).join("") || empty("还没有项目");
}

function hydrateCommunityFilter() {
  const select = $("#communityFilter");
  if (!select) return;
  const current = select.value;
  const communities = [...new Set(visible(db.projects).map(item => item.community).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  select.innerHTML = [`<option value="">全部小区</option>`, ...communities.map(item => `<option value="${esc(item)}">${esc(item)}</option>`)].join("");
  select.value = communities.includes(current) ? current : "";
}

function matchDeadlineFilter(deadline, mode) {
  if (!mode) return true;
  const date = normalizeReminderDate(deadline || "");
  if (mode === "none") return !date;
  if (!date) return false;
  if (mode === "overdue") return date < today();
  if (mode === "today") return date === today();
  if (mode === "week") return date >= today() && date <= addDays(today(), 7);
  return true;
}

function renderMoney() {
  const summary = receivableSummary();
  $("#expenseCards").innerHTML = visible(db.expenses).map(item => `
    <article class="card">
      <h3>${money(item.amount)} · ${esc(item.purpose)}</h3>
      <p class="meta">${esc(item.customer)} · 计划收回：${esc(item.dueDate || item.plannedReturnDate || "未设收回日期")}</p>
      <div class="chips"><span class="chip">${esc(item.status)}</span></div>
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="expenses" data-delete-id="${item.id}" data-delete-title="${esc(item.purpose || "垫付款")}">删除</button></div>
    </article>
  `).join("") || empty("暂无垫付款");
  if (summary.length) {
    $("#expenseCards").insertAdjacentHTML("afterbegin", `
      <article class="card">
        <h3>待收合计：${money(summary.reduce((sum, item) => sum + item.total, 0))}</h3>
        <p class="meta">${summary.map(item => `${item.customer} ${money(item.total)}`).join("；")}</p>
      </article>
    `);
  }
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
  hydrateFileProjectSelect();
  $("#fileCards").innerHTML = visible(db.files).map(file => `
    <article class="card">
      <div class="thumb">${file.dataUrl?.startsWith("data:image") ? `<img src="${file.dataUrl}" alt="${esc(file.name)}">` : file.url && /\.(png|jpe?g|webp|gif)$/i.test(file.url) ? `<img src="${esc(file.url)}" alt="${esc(file.name)}">` : "文件"}</div>
      <h3>${esc(file.name)}</h3>
      <p class="meta">${esc(file.customer || "未指定客户")} · ${esc(file.date)}</p>
      <p class="meta">${esc(file.space || "未设空间")} · ${esc(file.fileType || file.type || "未设类型")} · ${esc(file.version || "未设版本")}</p>
      ${file.fileSize ? `<p class="meta">大小：${formatFileSize(file.fileSize)}${file.compressed ? ` · 已压缩，原图 ${formatFileSize(file.originalSize)}` : ""}</p>` : ""}
      ${file.url ? `<p class="meta"><a href="${esc(file.url)}" target="_blank" rel="noopener">打开文件</a></p>` : ""}
      ${file.githubPath ? `<p class="meta">GitHub：${esc(file.githubPath)}</p>` : ""}
      <div class="card-actions"><button class="mini-action danger-text" data-delete-type="files" data-delete-id="${file.id}" data-delete-title="${esc(file.name)}">删除</button></div>
    </article>
  `).join("") || empty("还没有照片或文件");
}

function hydrateFileProjectSelect() {
  const select = $("#fileProjectSelect");
  if (!select) return;
  const current = select.value;
  select.innerHTML = [
    `<option value="">未指定项目</option>`,
    ...visible(db.projects).map(project => `<option value="${project.id}">${esc(project.customer)} - ${esc(project.name)}</option>`)
  ].join("");
  select.value = current;
}

function renderLogs() {
  $("#logCards").innerHTML = visible(db.logs).filter(item => !isAdminReminder(item.text)).map(logCard).join("") || empty("暂无记录");
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
  const tomorrowDate = addDays(date, 1);
  const summaryItems = uniqueReportItems(visible(db.logs)
    .filter(item => item.date === date && !isAdminReminder(item.text))
    .flatMap(item => reportSummaryFragments(item.text))
    .map(formalizeReportText)
    .filter(Boolean));
  const tomorrowItems = uniqueReportItems(visible(db.tasks)
    .filter(item => item.status !== "已完成")
    .filter(item => !isAdminReminder(`${item.title || ""} ${item.sourceText || ""}`))
    .filter(item => {
      const taskDate = normalizeReminderDate(item.dueDate || item.date || "");
      const raw = `${item.title || ""} ${item.sourceText || ""}`;
      return taskDate === tomorrowDate || (/明天|明日|明早|明晚/.test(raw) && item.createdAt?.startsWith(date));
    })
    .map(task => projectTaskReportText(task))
    .filter(Boolean));
  const summary = summaryItems.length ? summaryItems.join("；") : "暂无";
  const tomorrow = tomorrowItems.length ? tomorrowItems.join("；") : "暂无";
  return [
    "姓名：缪梦豪",
    `日期：${formatChineseDate(date)}`,
    `今日总结：${summary}`,
    `明日工作：${tomorrow}`
  ].join("\n");
}

function cleanReportText(text) {
  return String(text || "")
    .replace(/姓名：.*?(?=日期：|今日总结：|明日工作：|$)/g, "")
    .replace(/日期：.*?(?=今日总结：|明日工作：|$)/g, "")
    .replace(/今日总结：|明日工作：/g, "；")
    .replace(/^明天跟进：/, "")
    .replace(/^跟进整改\/修改：/, "")
    .replace(/^跟进垫付款收回$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。；;]+$/g, "");
}

function reportSummaryFragments(text) {
  const value = String(text || "");
  const summaryText = /今日总结：/.test(value) ? extractSection(value, "今日总结", "明日工作") : value;
  return summaryText
    .split(/[；;\n。]+/)
    .map(part => cleanReportText(part))
    .filter(part => part && !isAdminReminder(part) && !/^明日工作/.test(part));
}

function projectTaskReportText(task) {
  const title = cleanReportText(task.title || "");
  if (!title || isAdminReminder(title) || /^(提交)?日报$/.test(title)) return "";
  const project = visible(db.projects).find(item => item.id === task.projectId);
  const projectName = project ? projectDisplayName(project) : "";
  const cleanedTitle = title.replace(projectName, "").replace(/^[，,。；;：:\s]+/, "").trim();
  if (!cleanedTitle || isAdminReminder(cleanedTitle)) return "";
  return projectName && !cleanedTitle.includes(projectName) ? `${projectName}${cleanedTitle}` : cleanedTitle;
}

function uniqueReportItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = cleanReportText(item).replace(/\s+/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formalizeReportText(text) {
  let value = cleanReportText(text)
    .replace(/^(今天|今日|上午|下午|晚上|早上|中午)/, "")
    .replace(/^(去|到|去了|前往|跑了|开车去)/, "")
    .replace(/[，,；;]?\s*(往返|来回)?\s*\d+(?:\.\d+)?\s*(公里|km|KM).*?(?=，|,|；|;|。|$)/g, "")
    .replace(/[，,；;]?\s*(替客户|帮客户|垫付|付了|支付|报销).*?\d+(?:\.\d+)?\s*元.*?(?=，|,|；|;|。|$)/g, "")
    .replace(/[，,；;。]+$/g, "")
    .trim();
  if (!value) return "";
  value = value.replace(/家(?=(水电|量房|定位|对接|复尺|现场|验收))/, "住宅");
  if (!/^(完成|推进|对接|确认|修改|整理|跟进|现场)/.test(value)) value = `完成${value}`;
  return value;
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
  return project ? projectDisplayName(project) : fallbackCustomer;
}

function projectDisplayName(project) {
  return [project.community, project.unitNo].filter(Boolean).join("") || project.name || project.customer || "未指定项目";
}

function stagePrediction(stage) {
  const rules = [
    { keys: ["需求", "沟通"], days: 2, next: "整理需求并约量房", note: "需求沟通后通常 1-2 天内要确认下一步。" },
    { keys: ["量房"], days: 2, next: "出平面方案", note: "量房后通常 2 天左右要推进平面。" },
    { keys: ["平面"], days: 3, next: "确认平面并推进效果图", note: "平面方案后通常 3 天左右需要跟进确认。" },
    { keys: ["效果图"], days: 5, next: "跟进效果图修改/确认", note: "效果图阶段通常 3-5 天要提醒一次。" },
    { keys: ["施工图"], days: 3, next: "检查施工图并准备报价", note: "施工图阶段通常 3 天左右要核对输出。" },
    { keys: ["报价"], days: 2, next: "跟进报价确认/收款", note: "报价发出后通常 2 天内要跟进。" },
    { keys: ["合同"], days: 2, next: "确认合同和付款节点", note: "合同阶段要盯付款和开工资料。" },
    { keys: ["材料"], days: 3, next: "确认材料清单", note: "材料阶段通常 3 天左右要核对一次。" },
    { keys: ["水电", "泥瓦", "木工", "油漆", "定制"], days: 3, next: "现场/施工节点跟进", note: "施工阶段建议每 2-3 天跟进一次。" },
    { keys: ["软装"], days: 4, next: "确认软装清单和到货", note: "软装阶段建议 3-4 天跟进一次。" },
    { keys: ["验收"], days: 2, next: "安排验收和尾款", note: "验收阶段要提醒收尾款和问题整改。" }
  ];
  const text = String(stage || "");
  return rules.find(rule => rule.keys.some(key => text.includes(key))) || { days: 3, next: "跟进项目进度", note: "未识别具体阶段，默认 3 天后提醒。" };
}

function predictProjectNextDate(project) {
  const prediction = stagePrediction(project.stage);
  const baseDate = String(project.stageUpdatedAt || project.updatedAt || project.createdAt || today()).slice(0, 10);
  return addDays(normalizeReminderDate(baseDate) || today(), prediction.days);
}

function receivableSummary() {
  const map = new Map();
  for (const item of visible(db.expenses).filter(expense => expense.status !== "已收回")) {
    const key = item.customer || "未指定客户";
    const current = map.get(key) || { customer: key, total: 0, count: 0 };
    current.total += Number(item.amount || 0);
    current.count += 1;
    map.set(key, current);
  }
  return [...map.values()].filter(item => item.total > 0).sort((a, b) => b.total - a.total);
}

function normalizeReminderDate(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const now = new Date();
  if (/下班前|下班|今晚|今天晚上|上午|中午|下午|晚上/.test(text)) return today();
  if (/今天|今日/.test(text)) return today();
  if (/明天|明日/.test(text)) return addDays(today(), 1);
  if (/后天/.test(text)) return addDays(today(), 2);
  const weekday = text.match(/(?:下?周|星期|礼拜|周)([一二三四五六日天])/);
  if (weekday) return nextWeekdayDate(weekday[1], text.includes("下周"));
  const dayAfter = text.match(/(\d+)\s*天后/);
  if (dayAfter) return addDays(today(), Number(dayAfter[1]));
  const weekAfter = text.match(/(\d+)?\s*(周|星期|礼拜)后/);
  if (weekAfter) return addDays(today(), Number(weekAfter[1] || 1) * 7);
  if (/月底|月末/.test(text)) return monthEnd(now.getFullYear(), now.getMonth());
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(号|日)?/);
  if (monthDay) return dateFromParts(now.getFullYear(), Number(monthDay[1]), Number(monthDay[2]));
  const dayOnly = text.match(/(\d{1,2})\s*(号|日)/);
  if (dayOnly) return dateFromParts(now.getFullYear(), now.getMonth() + 1, Number(dayOnly[1]));
  return "";
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function monthEnd(year, zeroMonth) {
  return new Date(year, zeroMonth + 1, 0).toISOString().slice(0, 10);
}

function dateFromParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  return date.toISOString().slice(0, 10);
}

function nextWeekdayDate(label, forceNextWeek = false) {
  const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const target = map[label];
  const now = new Date(`${today()}T00:00:00`);
  let diff = target - now.getDay();
  if (diff <= 0 || forceNextWeek) diff += 7;
  return addDays(today(), diff);
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
  const projectOptions = visible(db.projects).map(p => `<option value="${p.id}">${esc(projectDisplayName(p))}</option>`).join("");
  $("#dialogFields").innerHTML = {
    project: `
      <label>客户姓名<input name="customer" placeholder="可先不填，例如：李女士"></label>
      <label>小区<input name="community" placeholder="例如：仁恒 / 长江天和"></label>
      <label>门牌号<input name="unitNo" placeholder="例如：4-1202 / 6-305"></label>
      <label>项目名称<input name="name" placeholder="可自动生成，例如：仁恒4-1202"></label>
      <label>交期<input name="deadline" placeholder="例如：8月5号 / 周五 / 月底"></label>
      <label>地址<input name="address" placeholder="详细地址，可后补"></label>
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
    const community = String(form.get("community") || "").trim();
    const unitNo = String(form.get("unitNo") || "").trim();
    const name = String(form.get("name") || "").trim() || [community, unitNo].filter(Boolean).join("") || `${customer}项目`;
    db.projects.unshift({
      id: id(),
      customer,
      name,
      community,
      unitNo,
      address: form.get("address") || "",
      deadline: normalizeReminderDate(form.get("deadline") || ""),
      stage: form.get("stage") || "待补充",
      style: form.get("style") || "",
      createdAt: new Date().toISOString(),
      stageUpdatedAt: new Date().toISOString()
    });
    db.projects[0].nextActionDate = predictProjectNextDate(db.projects[0]);
  }
  if (type === "expense") {
    const project = db.projects.find(p => p.id === form.get("projectId"));
    const plannedReturnDate = form.get("plannedReturnDate") || "";
    db.expenses.unshift({
      id: id(),
      projectId: project?.id || "",
      customer: project?.customer || "未指定客户",
      amount: Number(form.get("amount") || 0),
      purpose: form.get("purpose") || "待补充用途",
      plannedReturnDate,
      dueDate: normalizeReminderDate(plannedReturnDate),
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

async function handleFile(file) {
  if (!file) return;
  selectedUploadFile = file;
  $("#selectedFileName").textContent = `${file.name} · ${formatFileSize(file.size)}`;
  $("#fileUploadStatus").textContent = "正在检查文件...";
  try {
    const prepared = await prepareUploadFile(file);
    selectedUploadFile = prepared.file;
    selectedUploadFile.uploadOriginalName = file.name;
    selectedUploadFile.uploadOriginalSize = file.size;
    selectedUploadFile.uploadCompressed = prepared.compressed;
    $("#selectedFileName").textContent = `${prepared.file.name} · ${formatFileSize(prepared.file.size)}`;
    $("#fileUploadStatus").textContent = prepared.compressed
      ? `图片已自动压缩：${formatFileSize(file.size)} → ${formatFileSize(prepared.file.size)}，可以保存或上传。`
      : "已选择文件，可以保存到本机或上传到 GitHub。";
  } catch {
    selectedUploadFile = file;
    selectedUploadFile.uploadOriginalName = file.name;
    selectedUploadFile.uploadOriginalSize = file.size;
    selectedUploadFile.uploadCompressed = false;
    $("#fileUploadStatus").textContent = "图片压缩没有成功，已保留原文件。";
  }
}

function fileMetaFromForm(file) {
  const project = visible(db.projects).find(item => item.id === $("#fileProjectSelect").value);
  return {
    projectId: project?.id || "",
    customer: project?.customer || "未指定客户",
    projectName: project?.name || "未指定项目",
    space: $("#fileSpace").value.trim() || "未设空间",
    fileType: $("#fileType").value.trim() || guessFileType(file),
    version: $("#fileVersion").value.trim() || "未设版本",
    note: $("#fileNote").value.trim()
  };
}

function saveLocalSelectedFile() {
  const file = selectedUploadFile;
  if (!file) return toast("请先选择文件");
  if (!file.type?.startsWith("image/") && file.size > 2 * 1024 * 1024) {
    return toast("大文件请用“上传到 GitHub”，手机本机只保存小文件和压缩图");
  }
  const reader = new FileReader();
  reader.onload = () => {
    const meta = fileMetaFromForm(file);
    db.files.unshift({
      id: id(),
      name: file.name,
      type: file.type,
      ...meta,
      ...fileStorageMeta(file),
      dataUrl: reader.result,
      date: today(),
      createdAt: new Date().toISOString()
    });
    save();
    render();
    clearFileForm();
    toast("已保存到当前设备");
  };
  reader.readAsDataURL(file);
}

async function uploadSelectedFileToGithub() {
  const file = selectedUploadFile;
  if (!file) return toast("请先选择文件");
  if (file.size > 25 * 1024 * 1024 && !confirm("这个文件超过 25MB，不建议放 GitHub。仍然上传吗？")) return;
  try {
    readSyncSettingsFromForm();
    readRepoSettingsFromForm();
    $("#fileUploadStatus").textContent = "正在上传到 GitHub 仓库...";
    const dataUrl = await readFileAsDataUrl(file);
    const base64 = String(dataUrl).split(",")[1] || "";
    const meta = fileMetaFromForm(file);
    const githubPath = buildGithubFilePath(file, meta);
    const encodedPath = githubPath.split("/").map(encodeURIComponent).join("/");
    const result = await githubRequest(`/repos/${syncSettings.repoOwner}/${syncSettings.repoName}/contents/${encodedPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `upload ${githubPath}`,
        content: base64,
        branch: syncSettings.repoBranch || "main"
      })
    });
    const fileUrl = githubPagesFileUrl(githubPath);
    db.files.unshift({
      id: id(),
      name: file.name,
      type: file.type,
      ...meta,
      ...fileStorageMeta(file),
      dataUrl: dataUrl.startsWith("data:image") && dataUrl.length < 120000 ? dataUrl : "",
      url: fileUrl,
      githubOwner: syncSettings.repoOwner,
      githubRepo: syncSettings.repoName,
      githubBranch: syncSettings.repoBranch || "main",
      githubPath,
      githubSha: result.content?.sha || "",
      date: today(),
      createdAt: new Date().toISOString()
    });
    save();
    render();
    clearFileForm();
    $("#fileUploadStatus").textContent = "已上传到 GitHub，并生成文件链接。";
    toast("已上传到 GitHub");
  } catch (error) {
    $("#fileUploadStatus").textContent = error.message;
    toast(error.message);
  }
}

function clearFileForm() {
  selectedUploadFile = null;
  $("#fileInput").value = "";
  $("#selectedFileName").textContent = "还没有选择文件。";
  $("#fileSpace").value = "";
  $("#fileType").value = "";
  $("#fileVersion").value = "";
  $("#fileNote").value = "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fileStorageMeta(file) {
  return {
    originalName: file.uploadOriginalName || file.name,
    originalSize: file.uploadOriginalSize || file.size,
    fileSize: file.size,
    compressed: Boolean(file.uploadCompressed)
  };
}

async function prepareUploadFile(file) {
  if (!file.type?.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") {
    return { file, compressed: false };
  }
  if (file.size < 700 * 1024) return { file, compressed: false };
  const compressed = await compressImageFile(file);
  if (!compressed || compressed.size >= file.size) return { file, compressed: false };
  return { file: compressed, compressed: true };
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        if (!blob) return reject(new Error("图片压缩失败"));
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        resolve(new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }));
      }, "image/jpeg", 0.82);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    image.src = url;
  });
}

function formatFileSize(size) {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(size / 1024))}KB`;
}

function guessFileType(file) {
  if (file.type?.startsWith("image/")) return "现场照片";
  if (/\.pdf$/i.test(file.name)) return "PDF";
  if (/\.(dwg|dxf)$/i.test(file.name)) return "施工图";
  if (/\.(docx?|xlsx?)$/i.test(file.name)) return "文档";
  return "文件";
}

function buildGithubFilePath(file, meta) {
  const folder = sanitizePathPart(syncSettings.repoFolder || "files");
  const project = sanitizePathPart(meta.projectName || meta.customer || "未指定项目");
  const space = sanitizePathPart(meta.space || "未设空间");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = sanitizeFileName(file.name);
  return `${folder}/${project}/${space}/${stamp}-${name}`;
}

function sanitizePathPart(value) {
  return String(value || "未命名").trim().replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "未命名";
}

function sanitizeFileName(value) {
  return String(value || "file").trim().replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "-").replace(/\s+/g, "-").slice(0, 120) || "file";
}

function githubPagesFileUrl(path) {
  return `https://${syncSettings.repoOwner}.github.io/${syncSettings.repoName}/${path.split("/").map(encodeURIComponent).join("/")}`;
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
  const owner = $("#repoOwner");
  const repo = $("#repoName");
  const branch = $("#repoBranch");
  const folder = $("#repoFolder");
  if (!token) return;
  if (![token, gist, owner, repo, branch, folder].includes(document.activeElement)) {
    token.value = syncSettings.token || "";
    gist.value = syncSettings.gistId || "";
    owner.value = syncSettings.repoOwner || "gracejm0323-beep";
    repo.value = syncSettings.repoName || "designer-secretary-mobile";
    branch.value = syncSettings.repoBranch || "main";
    folder.value = syncSettings.repoFolder || "files";
  }
}

function readSyncSettingsFromForm() {
  syncSettings.token = $("#syncToken").value.trim();
  syncSettings.gistId = $("#syncGistId").value.trim();
  saveSyncSettings();
  if (!syncSettings.token) throw new Error("请先填写 GitHub Token");
}

function readRepoSettingsFromForm() {
  syncSettings.repoOwner = $("#repoOwner").value.trim() || "gracejm0323-beep";
  syncSettings.repoName = $("#repoName").value.trim() || "designer-secretary-mobile";
  syncSettings.repoBranch = $("#repoBranch").value.trim() || "main";
  syncSettings.repoFolder = $("#repoFolder").value.trim() || "files";
  saveSyncSettings();
  if (!syncSettings.repoOwner || !syncSettings.repoName) throw new Error("请填写 GitHub 用户名和仓库名");
}

function saveRepoSettings() {
  try {
    readRepoSettingsFromForm();
    toast("文件库设置已保存");
  } catch (error) {
    toast(error.message);
  }
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

function backupPayload() {
  const copy = syncPayload();
  copy.meta.backupType = "github-file-library";
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
    readRepoSettingsFromForm();
    const encodedPath = item.githubPath.split("/").map(encodeURIComponent).join("/");
    await githubRequest(`/repos/${item.githubOwner || syncSettings.repoOwner}/${item.githubRepo || syncSettings.repoName}/contents/${encodedPath}`, {
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

function completeReminder(kind, itemId) {
  const now = new Date().toISOString();
  if (kind === "task") {
    const task = db.tasks.find(item => item.id === itemId);
    if (!task) return;
    task.status = "已完成";
    task.completedAt = now;
    task.updatedAt = now;
    toast("已完成");
  }
  if (kind === "project") {
    const project = db.projects.find(item => item.id === itemId);
    if (!project) return;
    project.lastFollowedAt = now;
    project.nextActionDate = addDays(today(), stagePrediction(project.stage).days);
    project.updatedAt = now;
    toast("已记录跟进，下次提醒已后移");
  }
  if (kind === "expense") {
    const expense = db.expenses.find(item => item.id === itemId);
    if (!expense) return;
    expense.status = "已收回";
    expense.receivedAt = now;
    expense.updatedAt = now;
    toast("已标记收回");
  }
  save();
  render();
}

function openRescheduleDialog(kind, itemId, title) {
  pendingReschedule = { kind, itemId };
  $("#rescheduleSummary").textContent = `改期：${title || "这条提醒"}`;
  $("#rescheduleText").value = "";
  $("#rescheduleDialog").showModal();
  setTimeout(() => $("#rescheduleText").focus(), 50);
}

function saveReschedule() {
  if (!pendingReschedule) return;
  const text = $("#rescheduleText").value.trim();
  if (!text) return toast("请写新的时间，例如：后天9点");
  const parsed = parseReminderDateTime(text);
  const now = new Date().toISOString();
  if (pendingReschedule.kind === "task") {
    const task = db.tasks.find(item => item.id === pendingReschedule.itemId);
    if (!task) return toast("没有找到这条待办");
    task.date = parsed.date;
    task.dueDate = parsed.date;
    task.dueTime = parsed.time;
    task.rescheduledAt = now;
    task.rescheduleNote = text;
    task.updatedAt = now;
  }
  if (pendingReschedule.kind === "project") {
    const project = db.projects.find(item => item.id === pendingReschedule.itemId);
    if (!project) return toast("没有找到这个项目");
    project.nextActionDate = parsed.date;
    project.nextActionTime = parsed.time;
    project.rescheduledAt = now;
    project.rescheduleNote = text;
    project.updatedAt = now;
  }
  if (pendingReschedule.kind === "expense") {
    const expense = db.expenses.find(item => item.id === pendingReschedule.itemId);
    if (!expense) return toast("没有找到这笔待收");
    expense.dueDate = parsed.date;
    expense.plannedReturnDate = parsed.date;
    expense.dueTime = parsed.time;
    expense.rescheduledAt = now;
    expense.rescheduleNote = text;
    expense.updatedAt = now;
  }
  save();
  $("#rescheduleDialog").close();
  render();
  toast(`已改到 ${parsed.date} ${parsed.time}`);
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

async function backupToGithub() {
  try {
    readSyncSettingsFromForm();
    readRepoSettingsFromForm();
    $("#githubBackupStatus").textContent = "正在备份到 GitHub 文件库...";
    const folder = sanitizePathPart(syncSettings.repoFolder || "files");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${folder}/_backups/${stamp}-designer-secretary-backup.json`;
    const encodedPath = backupPath.split("/").map(encodeURIComponent).join("/");
    await githubRequest(`/repos/${syncSettings.repoOwner}/${syncSettings.repoName}/contents/${encodedPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `backup ${backupPath}`,
        content: stringToBase64(JSON.stringify(backupPayload(), null, 2)),
        branch: syncSettings.repoBranch || "main"
      })
    });
    $("#githubBackupStatus").textContent = `已备份：${backupPath}`;
    toast("已备份到 GitHub 文件库");
    await loadGithubBackups();
  } catch (error) {
    $("#githubBackupStatus").textContent = error.message;
    toast(error.message);
  }
}

async function loadGithubBackups() {
  try {
    readSyncSettingsFromForm();
    readRepoSettingsFromForm();
    $("#githubBackupStatus").textContent = "正在读取备份列表...";
    const folder = `${sanitizePathPart(syncSettings.repoFolder || "files")}/_backups`;
    const encodedPath = folder.split("/").map(encodeURIComponent).join("/");
    const files = await githubRequest(`/repos/${syncSettings.repoOwner}/${syncSettings.repoName}/contents/${encodedPath}?ref=${encodeURIComponent(syncSettings.repoBranch || "main")}`);
    const backups = (Array.isArray(files) ? files : [])
      .filter(file => file.name?.endsWith(".json"))
      .sort((a, b) => b.name.localeCompare(a.name));
    $("#githubBackupSelect").innerHTML = backups.map(file => `<option value="${esc(file.path)}">${esc(file.name)}</option>`).join("");
    $("#githubBackupStatus").textContent = backups.length ? `找到 ${backups.length} 个备份。` : "还没有备份。";
  } catch (error) {
    const emptyMessage = /not found/i.test(error.message) ? "还没有备份文件夹，先点“备份到文件库”。" : error.message;
    $("#githubBackupSelect").innerHTML = "";
    $("#githubBackupStatus").textContent = emptyMessage;
    toast(emptyMessage);
  }
}

async function restoreGithubBackup() {
  const backupPath = $("#githubBackupSelect").value;
  if (!backupPath) return toast("请先选择一个备份");
  try {
    readSyncSettingsFromForm();
    readRepoSettingsFromForm();
    $("#githubBackupStatus").textContent = "正在下载并恢复备份...";
    const encodedPath = backupPath.split("/").map(encodeURIComponent).join("/");
    const file = await githubRequest(`/repos/${syncSettings.repoOwner}/${syncSettings.repoName}/contents/${encodedPath}?ref=${encodeURIComponent(syncSettings.repoBranch || "main")}`);
    const incoming = normalizeDb(JSON.parse(base64ToString(file.content || "")));
    db = mergeDb(db, incoming);
    save();
    render();
    $("#githubBackupStatus").textContent = "备份已恢复并合并到当前设备。";
    toast("备份已恢复");
  } catch (error) {
    $("#githubBackupStatus").textContent = error.message;
    toast(error.message);
  }
}

function stringToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToString(value) {
  const binary = atob(String(value).replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

$$("[data-tab]").forEach(button => button.addEventListener("click", () => setTab(button.dataset.tab)));
$("#saveQuickBtn").addEventListener("click", () => {
  const text = $("#quickText").value.trim();
  if (!text) return toast("先写一句要记录的内容");
  const insight = parseText(text);
  $("#quickText").value = "";
  render();
  $("#secretaryInsight").textContent = buildInsight(insight);
  toast("已整理到对应位置");
});
$("#clearRecentBtn").addEventListener("click", clearRecentLogs);
$("#voiceBtn").addEventListener("click", startVoice);
$("#addProjectBtn").addEventListener("click", () => openForm("project"));
$("#addExpenseBtn").addEventListener("click", () => openForm("expense"));
$("#addMileageBtn").addEventListener("click", () => openForm("mileage"));
$("#startTrackBtn").addEventListener("click", startTracking);
$("#stopTrackBtn").addEventListener("click", stopTracking);
$("#dialogForm").addEventListener("submit", submitForm);
$("#dialogCloseBtn").addEventListener("click", () => $("#formDialog").close());
$("#projectSearch").addEventListener("input", renderProjects);
$("#communityFilter").addEventListener("change", renderProjects);
$("#deadlineFilter").addEventListener("change", renderProjects);
$("#fileInput").addEventListener("change", event => handleFile(event.target.files[0]));
$("#saveLocalFileBtn").addEventListener("click", saveLocalSelectedFile);
$("#uploadGithubFileBtn").addEventListener("click", uploadSelectedFileToGithub);
$("#exportBtn").addEventListener("click", exportData);
$("#exportBtn2").addEventListener("click", exportData);
$("#importBtn").addEventListener("click", () => $("#importInput").click());
$("#importInput").addEventListener("change", event => importData(event.target.files[0]));
$("#pushSyncBtn").addEventListener("click", pushSync);
$("#pullSyncBtn").addEventListener("click", () => pullSync({ merge: true }));
$("#mergeSyncBtn").addEventListener("click", mergeSync);
$("#saveRepoSettingsBtn").addEventListener("click", saveRepoSettings);
$("#backupToGithubBtn").addEventListener("click", backupToGithub);
$("#loadGithubBackupsBtn").addEventListener("click", loadGithubBackups);
$("#restoreGithubBackupBtn").addEventListener("click", restoreGithubBackup);
document.addEventListener("click", event => {
  const completeButton = event.target.closest("[data-complete-kind]");
  if (completeButton) {
    completeReminder(completeButton.dataset.completeKind, completeButton.dataset.completeId);
    return;
  }
  const rescheduleButton = event.target.closest("[data-reschedule-kind]");
  if (rescheduleButton) {
    openRescheduleDialog(rescheduleButton.dataset.rescheduleKind, rescheduleButton.dataset.rescheduleId, rescheduleButton.dataset.rescheduleTitle);
    return;
  }
  const button = event.target.closest("[data-delete-type]");
  if (!button) return;
  openDeleteDialog(button.dataset.deleteType, button.dataset.deleteId, button.dataset.deleteTitle);
});
$("#deleteCloseBtn").addEventListener("click", () => $("#deleteDialog").close());
$("#deleteLocalBtn").addEventListener("click", deleteCurrentDevice);
$("#deleteSyncBtn").addEventListener("click", deleteEverywhere);
$("#deleteGithubBtn").addEventListener("click", deleteGithubFile);
$("#rescheduleCloseBtn").addEventListener("click", () => $("#rescheduleDialog").close());
$("#rescheduleSaveBtn").addEventListener("click", saveReschedule);
$("#rescheduleText").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveReschedule();
  }
});
$("#reportProjectSelect").addEventListener("change", renderReports);
$("#copyDailyBtn").addEventListener("click", () => copyText($("#dailyReport").textContent, "日报"));
$("#copyProjectReportBtn").addEventListener("click", () => copyText($("#projectReport").textContent, "项目进度报告"));
$("#copyMileageBtn").addEventListener("click", () => copyText($("#mileageReport").textContent, "里程记录"));
$("#exportMileageCsvBtn").addEventListener("click", exportMileageCsv);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
render();
