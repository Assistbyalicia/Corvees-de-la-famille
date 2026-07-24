// Config et helpers partagés entre les 3 pages (index, kids, adults).
const STORAGE_KEY = "corvees-famille-v1";
const API_CONFIG_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/03ec9874-25e6-483b-8305-4f622e53a24a";
const API_COMPLETE_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/corvees-complete";

// --- Authentification légère ---
// Pas une vraie sécurité : ceci est un fichier statique sans serveur, donc ces
// codes sont visibles en clair par quiconque ouvre ce fichier. Ça sert juste
// à éviter qu'un enfant clique par erreur sur l'espace admin ou sur celui
// d'un autre. Change les codes ci-dessous, et ajoute une ligne par personne.
const AUTH_ADMINS = ["maman"];
const AUTH_PINS = {
  maman: "1234",
  Roxanne: "1111",
  Elena: "2222",
  Steven: "5678"
};

const SESSION_KEY = "corvees-famille-session";

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setSession(personId) {
  const session = { personId, isAdmin: AUTH_ADMINS.includes(personId) };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function checkPin(personId, pin) {
  return AUTH_PINS[personId] !== undefined && AUTH_PINS[personId] === pin;
}

const defaultData = {
  children: [],
  adults: [],
  chores: [],
  rewards: [],
  activeChildId: null,
  activeAdultId: null,
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
// pour les ids qu'il connaît. Seules les entrées explicitement marquées
// _source: "local" (ajoutées via les formulaires, pas encore synchronisées
// avec Notion) sont conservées en plus — les autres, si elles ont disparu de
// Notion (supprimées là-bas), disparaissent aussi de l'app au lieu de rester
// en cache indéfiniment dans le localStorage.
function mergeById(configItems, localItems) {
  const list = configItems || [];
  const configIds = new Set(list.map(item => item.id));
  const localOnly = (localItems || []).filter(
    item => item._source === "local" && !configIds.has(item.id)
  );
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
      rewards: mergeById(config.rewards, local.rewards),
      offline: false
    };
  } catch (e) {
    console.warn("API non disponible, utilisation du localStorage/defaultData :", e);
    return { ...defaultData, ...local, offline: true };
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
// par l'automatisation (et visible depuis les autres appareils). personIds
// est un tableau (une corvée peut être assignée à plusieurs personnes).
async function postAddChore(choreId, label, stars, personIds) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_chore",
        choreId,
        label,
        stars,
        personIds
      })
    });
  } catch (e) {
    console.warn("Impossible de créer la corvée dans Notion :", e);
  }
}

// action: "add_reward" — crée la récompense dans Notion. personIds est un tableau.
async function postAddReward(rewardId, label, cost, personIds) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_reward",
        rewardId,
        label,
        cost,
        personIds
      })
    });
  } catch (e) {
    console.warn("Impossible de créer la récompense dans Notion :", e);
  }
}

// action: "update_chore_assignment" — remplace la liste de personnes assignées
// à une corvée existante (relation "Assignée à" côté Notion).
async function postUpdateChoreAssignment(choreId, personIds) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_chore_assignment",
        choreId,
        personIds
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour l'assignation de la corvée dans Notion :", e);
  }
}

// action: "update_reward_assignment" — idem pour une récompense.
async function postUpdateRewardAssignment(rewardId, personIds) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_reward_assignment",
        rewardId,
        personIds
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour l'assignation de la récompense dans Notion :", e);
  }
}

// action: "delete_reward" — archive la récompense dans Notion.
async function postDeleteReward(rewardId) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete_reward",
        rewardId
      })
    });
  } catch (e) {
    console.warn("Impossible de supprimer la récompense dans Notion :", e);
  }
}

// action: "delete_chore" — archive la corvée dans Notion.
async function postDeleteChore(choreId) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete_chore",
        choreId
      })
    });
  } catch (e) {
    console.warn("Impossible de supprimer la corvée dans Notion :", e);
  }
}

// Affiche/masque un bandeau "hors-ligne" si l'API de config n'a pas répondu.
function renderOfflineBadge(data) {
  const badge = document.getElementById("offline-badge");
  if (!badge) return;
  badge.style.display = data.offline ? "block" : "none";
}
