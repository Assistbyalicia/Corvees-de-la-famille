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
      stars: 0
    };
  }
  return data.state[personId][dayKey];
}

async function fetchRemoteConfig() {
  const res = await fetch(API_CONFIG_URL);
  if (!res.ok) throw new Error("API config non disponible");
  const payload = await res.json();
  return Array.isArray(payload) ? payload[0] : payload;
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
      children: config.children || local.children || defaultData.children,
      adults: config.adults || local.adults || defaultData.adults,
      chores: config.chores || local.chores || defaultData.chores,
      rewards: config.rewards || local.rewards || defaultData.rewards
    };
  } catch (e) {
    console.warn("API non disponible, utilisation du localStorage/defaultData :", e);
    return { ...defaultData, ...local };
  }
}

async function postChoreComplete(personId, choreId) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personId,
        choreId,
        date: getTodayKey()
      })
    });
  } catch (e) {
    console.warn("Impossible de journaliser la corvée dans Notion :", e);
  }
}
