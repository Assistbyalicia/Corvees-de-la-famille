// Config et helpers partagés entre les 3 pages (index, kids, adults).
const STORAGE_KEY = "corvees-famille-v1";
const API_CONFIG_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/03ec9874-25e6-483b-8305-4f622e53a24a";
const API_COMPLETE_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/corvees-complete";

const defaultData = {
  children: [],
  adults: [],
  chores: [],
  rewards: [],
  activeChildId: null,
  state: {}
};

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...defaultData };
  try {
    const parsed = JSON.parse(raw);
    return { ...defaultData, ...parsed };
  } catch (e) {
    console.error("Erreur de parsing localStorage", e);
    return { ...defaultData };
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getTodayKey() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function getPersonDayState(personId) {
  const dayKey = getTodayKey();
  if (!data.state[personId]) {
    data.state[personId] = {};
  }
  if (!data.state[personId][dayKey]) {
    data.state[personId][dayKey] = {
      completedChores: [],
      purchasedRewards: [],
      stars: 0
    };
  }
  if (!data.state[personId][dayKey].purchasedRewards) {
    data.state[personId][dayKey].purchasedRewards = [];
  }
  return data.state[personId][dayKey];
}

async function fetchRemoteConfig() {
  const res = await fetch(API_CONFIG_URL);
  if (!res.ok) throw new Error("API config non disponible");
  const payload = await res.json();
  return Array.isArray(payload) ? payload[0] : payload;
}

// Combine une liste venant de Notion avec une liste locale : Notion fait autorité
// pour les ids qu'il connaît, les entrées ajoutées localement (ex. via les
// formulaires "Ajouter une corvée/récompense") sont conservées en plus.
function mergeById(configItems, localItems) {
  const list = configItems || [];
  const configIds = new Set(list.map(item => item.id));
  const localOnly = (localItems || []).filter(item => !configIds.has(item.id));
  return [...list, ...localOnly];
}

// Fusionne la config N8N/Notion avec le localStorage local (personnes, corvées, récompenses).
// Le state (corvées faites du jour) reste toujours celui du localStorage.
async function loadAppData() {
  const local = loadData();

  try {
    const config = await fetchRemoteConfig();
    return {
      ...defaultData,
      ...local,
      children: mergeById(config.children, local.children),
      adults: mergeById(config.adults, local.adults),
      chores: mergeById(config.chores, local.chores),
      rewards: mergeById(config.rewards, local.rewards)
    };
  } catch (e) {
    console.warn("API non disponible, utilisation du localStorage/defaultData :", e);
    return { ...defaultData, ...local };
  }
}

// action: "complete" | "cancel" — un seul webhook, N8N distingue via le champ "action".
async function postChoreAction(personId, choreId, action) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        personId,
        choreId,
        date: getTodayKey()
      })
    });
  } catch (e) {
    console.warn("Impossible de journaliser la corvée dans Notion :", e);
  }
}

// action: "purchase" pour l'instant.
async function postRewardAction(personId, rewardId, action) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        personId,
        rewardId,
        date: getTodayKey()
      })
    });
  } catch (e) {
    console.warn("Impossible de journaliser la récompense dans Notion :", e);
  }
}

// action: "add_chore" — crée la corvée dans Notion pour qu'elle soit reconnue
// par l'automatisation (et visible depuis les autres appareils).
async function postAddChore(choreId, label, stars, personId) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_chore",
        choreId,
        label,
        stars,
        personId
      })
    });
  } catch (e) {
    console.warn("Impossible de créer la corvée dans Notion :", e);
  }
}

// action: "add_reward" — crée la récompense dans Notion.
async function postAddReward(rewardId, label, cost) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_reward",
        rewardId,
        label,
        cost
      })
    });
  } catch (e) {
    console.warn("Impossible de créer la récompense dans Notion :", e);
  }
}
