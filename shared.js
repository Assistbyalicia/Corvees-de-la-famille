// Config et helpers partagés entre les 3 pages (index, kids, adults).
const STORAGE_KEY = "corvees-famille-v1";
const API_CONFIG_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/03ec9874-25e6-483b-8305-4f622e53a24a";
const API_COMPLETE_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/corvees-complete";

// Rend l'appli installable (icône sur l'écran d'accueil) et lui permet de
// charger même sans réseau, voir sw.js.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("Service worker non installé :", e));
  });
}

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

// Code de récupération familial : à donner oralement à quelqu'un qui a oublié
// son code personnel, pour qu'il/elle puisse en choisir un nouveau sans
// connaître l'ancien (voir "Code oublié ?" sur la page de connexion).
// Change-le si tu veux, comme les codes ci-dessus il n'apporte aucune vraie
// sécurité, il sert juste à éviter qu'on réinitialise le code de quelqu'un
// d'autre par erreur ou curiosité.
const FAMILY_RECOVERY_CODE = "7777";

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

// Le code d'une personne vient de Notion (propriété "Code", champ `pin` dans
// la config) si elle en a défini un ; sinon on retombe sur AUTH_PINS
// ci-dessus (utile pour une personne qui n'a pas encore de code dans Notion).
function checkPin(personId, pin, allPeople) {
  const person = (allPeople || []).find(p => p.id === personId);
  const expected = (person && person.pin) || AUTH_PINS[personId];
  return expected !== undefined && expected === pin;
}

// La question secrète (et sa réponse) ne vient que de Notion : contrairement
// au code, il n'y a pas de valeur par défaut codée en dur, chacun la définit
// lui-même depuis "Ma question secrète" une fois connecté.
function checkSecurityAnswer(personId, answer, allPeople) {
  const person = (allPeople || []).find(p => p.id === personId);
  if (!person || !person.answer) return false;
  return person.answer.trim().toLowerCase() === (answer || "").trim().toLowerCase();
}

const defaultData = {
  children: [],
  adults: [],
  chores: [],
  rewards: [],
  weeklyRecap: { days: [] },
  rewardHistory: [],
  choreHistory: [],
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
    const merged = {
      ...defaultData,
      ...local,
      children: mergeById(config.children, local.children),
      adults: mergeById(config.adults, local.adults),
      chores: mergeById(config.chores, local.chores),
      rewards: mergeById(config.rewards, local.rewards),
      weeklyRecap: config.weeklyRecap || { days: [] },
      rewardHistory: config.rewardHistory || [],
      choreHistory: config.choreHistory || [],
      offline: false
    };
    // On réécrit le cache local avec le résultat fusionné : une corvée/récompense
    // créée depuis l'appli perd son marquage "local" dès qu'elle apparaît dans
    // Notion (elle est alors renvoyée telle quelle par la config, sans _source).
    // Sans ça, l'ancienne entrée _source:"local" restait dans le localStorage
    // et réapparaissait comme un fantôme même après suppression dans Notion.
    saveData(merged);
    return merged;
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
// frequency: "quotidien" (défaut) | "hebdomadaire" | "ponctuel" ; weeklyDays
// (tableau de jours, 0=dimanche...6=samedi) n'est utile que pour "hebdomadaire".
async function postAddChore(choreId, label, stars, personIds, frequency, weeklyDays) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_chore",
        choreId,
        label,
        stars,
        personIds,
        frequency,
        weeklyDays
      })
    });
  } catch (e) {
    console.warn("Impossible de créer la corvée dans Notion :", e);
  }
}

// action: "update_chore_frequency" — change la fréquence (et les jours, si
// hebdomadaire) d'une corvée existante.
async function postUpdateChoreFrequency(choreId, frequency, weeklyDays) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_chore_frequency",
        choreId,
        frequency,
        weeklyDays
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour la fréquence de la corvée dans Notion :", e);
  }
}

// action: "update_chore_details" — change le nom et/ou la valeur en étoiles
// d'une corvée existante.
async function postUpdateChoreDetails(choreId, label, stars) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_chore_details",
        choreId,
        label,
        stars
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour la corvée dans Notion :", e);
  }
}

// action: "update_reward_details" — change le nom et/ou le coût d'une
// récompense existante.
async function postUpdateRewardDetails(rewardId, label, cost) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_reward_details",
        rewardId,
        label,
        cost
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour la récompense dans Notion :", e);
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

// action: "propose_reward" — un enfant propose une récompense sans coût ; elle
// reste "en attente" (reward.pending côté config) jusqu'à ce qu'un adulte lui
// attribue un coût via postUpdateRewardCost.
async function postProposeReward(rewardId, label, personId) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "propose_reward",
        rewardId,
        label,
        personId
      })
    });
  } catch (e) {
    console.warn("Impossible de proposer la récompense dans Notion :", e);
  }
}

// action: "update_reward_cost" — un adulte attribue un coût à une récompense
// proposée par un enfant, ce qui l'active (elle n'est plus "en attente").
async function postUpdateRewardCost(rewardId, cost) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_reward_cost",
        rewardId,
        cost
      })
    });
  } catch (e) {
    console.warn("Impossible de valider le coût de la récompense dans Notion :", e);
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

// action: "update_pin" — enregistre le nouveau code de la personne dans Notion.
async function postUpdatePin(personId, newPin) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_pin",
        personId,
        newPin
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour le code dans Notion :", e);
  }
}

// action: "update_security_question" — enregistre la question/réponse secrète
// de la personne dans Notion (utilisée par le flux "Code oublié ?").
async function postUpdateSecurityQuestion(personId, question, answer) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_security_question",
        personId,
        question,
        answer
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour la question secrète dans Notion :", e);
  }
}

// action: "update_avatar" — enregistre l'emoji choisi par la personne dans
// Notion, pour le retrouver sur tous les appareils.
async function postUpdateAvatar(personId, avatar) {
  try {
    await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_avatar",
        personId,
        avatar
      })
    });
  } catch (e) {
    console.warn("Impossible de mettre à jour l'avatar dans Notion :", e);
  }
}

// Emoji d'une personne, avec un repli neutre si elle n'en a pas encore choisi.
function getPersonAvatar(person) {
  return (person && person.avatar) || "🙂";
}

const CHORE_FREQUENCIES = [
  { value: "quotidien", label: "Quotidien" },
  { value: "hebdomadaire", label: "Hebdomadaire" },
  { value: "ponctuel", label: "Ponctuel" }
];

const CHORE_WEEKDAYS = [
  { value: 0, label: "Dimanche" },
  { value: 1, label: "Lundi" },
  { value: 2, label: "Mardi" },
  { value: 3, label: "Mercredi" },
  { value: 4, label: "Jeudi" },
  { value: 5, label: "Vendredi" },
  { value: 6, label: "Samedi" }
];

// Une corvée "quotidien" (ou sans fréquence définie, pour compat avec les
// corvées créées avant cette fonctionnalité) est toujours visible : le
// state étant remis à zéro chaque jour, elle "recommence" naturellement.
// Une corvée "hebdomadaire" n'est visible que les jours choisis (weeklyDays,
// un ou plusieurs jours). Une corvée "ponctuelle" reste visible jusqu'à ce
// qu'elle soit faite, puis elle est supprimée (voir kids.html/adults.html).
function isChoreVisibleToday(chore) {
  const frequency = chore.frequency || "quotidien";
  if (frequency !== "hebdomadaire") return true;
  if (!chore.weeklyDays || chore.weeklyDays.length === 0) return true;
  return chore.weeklyDays.includes(new Date().getDay());
}

const WEEKLY_RECAP_WEEKDAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

function formatWeeklyRecapDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${WEEKLY_RECAP_WEEKDAYS[d.getDay()]} ${dd}/${mm}`;
}

// Nombre de jours d'affilée (dans la fenêtre des 7 derniers jours fournie par
// weeklyRecap) où personId a gagné au moins une étoile. Si le jour le plus
// récent (aujourd'hui) est encore à 0, on part de la veille pour ne pas
// casser la série avant même que la journée soit terminée.
function computeStreak(days, personId) {
  if (!days || days.length === 0) return 0;

  let endIndex = days.length - 1;
  if (!((days[endIndex].points && days[endIndex].points[personId]) > 0)) {
    endIndex -= 1;
  }

  let streak = 0;
  for (let i = endIndex; i >= 0; i--) {
    const points = (days[i].points && days[i].points[personId]) || 0;
    if (points > 0) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

// Affiche un vrai tableau jour x personne pour les 7 derniers jours
// (data.weeklyRecap.days, calculé côté n8n à partir du Journal Notion) dans
// #containerId. `people` filtre les colonnes affichées (ex. seulement les
// enfants côté kids.html, enfants+adultes côté adults.html) ; les colonnes
// sont triées par total décroissant. highlightPersonId (optionnel) met en
// valeur la colonne de cette personne.
function renderWeeklyRecapTable(containerId, data, people, highlightPersonId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";

  const days = (data.weeklyRecap && data.weeklyRecap.days) || [];

  if (!people || people.length === 0 || days.length === 0) {
    const p = document.createElement("p");
    p.className = "small";
    p.textContent = "Pas encore de données pour cette semaine.";
    container.appendChild(p);
    return;
  }

  const totalsByPerson = {};
  people.forEach(person => {
    totalsByPerson[person.id] = days.reduce(
      (sum, day) => sum + ((day.points && day.points[person.id]) || 0),
      0
    );
  });
  const sortedPeople = [...people].sort(
    (a, b) => totalsByPerson[b.id] - totalsByPerson[a.id]
  );

  container.style.overflowX = "auto";

  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const thDay = document.createElement("th");
  thDay.textContent = "Jour";
  headRow.appendChild(thDay);
  sortedPeople.forEach(person => {
    const th = document.createElement("th");
    th.textContent = person.name;
    if (person.id === highlightPersonId) th.style.color = "var(--color-primary)";
    headRow.appendChild(th);
  });
  const thTotal = document.createElement("th");
  thTotal.textContent = "Total";
  headRow.appendChild(thTotal);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  days.forEach(day => {
    const tr = document.createElement("tr");

    const tdDay = document.createElement("td");
    tdDay.textContent = formatWeeklyRecapDay(day.date);
    tr.appendChild(tdDay);

    let dayTotal = 0;
    sortedPeople.forEach(person => {
      const points = (day.points && day.points[person.id]) || 0;
      dayTotal += points;

      const td = document.createElement("td");
      td.textContent = points ? `⭐ ${points}` : "–";
      tr.appendChild(td);
    });

    const tdDayTotal = document.createElement("td");
    tdDayTotal.textContent = dayTotal ? `⭐ ${dayTotal}` : "–";
    tr.appendChild(tdDayTotal);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tfoot = document.createElement("tfoot");
  const footRow = document.createElement("tr");
  const tdLabel = document.createElement("td");
  tdLabel.textContent = "Total";
  tdLabel.style.fontWeight = "700";
  footRow.appendChild(tdLabel);

  let grandTotal = 0;
  sortedPeople.forEach(person => {
    const td = document.createElement("td");
    td.style.fontWeight = "700";
    td.textContent = `⭐ ${totalsByPerson[person.id]}`;
    grandTotal += totalsByPerson[person.id];
    footRow.appendChild(td);
  });
  const tdGrandTotal = document.createElement("td");
  tdGrandTotal.style.fontWeight = "700";
  tdGrandTotal.textContent = `⭐ ${grandTotal}`;
  footRow.appendChild(tdGrandTotal);
  tfoot.appendChild(footRow);
  table.appendChild(tfoot);

  container.appendChild(table);
}

// Câble un jeu d'onglets partagé (.tab-btn / .tab-panel, voir shared.css).
// defaultTab (ex. "quetes") force l'onglet actif initial ; sinon c'est le
// premier bouton présent dans le DOM qui est utilisé.
function setupTabs(defaultTab) {
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));

  function activate(tabName) {
    buttons.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    panels.forEach(panel => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
  }

  buttons.forEach(btn => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });

  if (buttons.length > 0) {
    activate(defaultTab || buttons[0].dataset.tab);
  }
}

// Affiche/masque un bandeau "hors-ligne" si l'API de config n'a pas répondu.
function renderOfflineBadge(data) {
  const badge = document.getElementById("offline-badge");
  if (!badge) return;
  badge.style.display = data.offline ? "block" : "none";
}

// Formulaire partagé "Changer mon code" : attend les éléments d'id
// change-pin-current / change-pin-new / change-pin-confirm / change-pin-btn /
// change-pin-message sur la page.
function setupChangePinForm(session, allPeople) {
  const btn = document.getElementById("change-pin-btn");
  const currentInput = document.getElementById("change-pin-current");
  const newInput = document.getElementById("change-pin-new");
  const confirmInput = document.getElementById("change-pin-confirm");
  const message = document.getElementById("change-pin-message");

  if (!btn || !currentInput || !newInput || !confirmInput || !message) return;

  btn.addEventListener("click", async () => {
    message.style.display = "none";

    const current = currentInput.value.trim();
    const next = newInput.value.trim();
    const confirmValue = confirmInput.value.trim();

    if (!checkPin(session.personId, current, allPeople)) {
      message.textContent = "Code actuel incorrect.";
      message.style.display = "block";
      return;
    }
    if (!next) {
      message.textContent = "Merci de saisir un nouveau code.";
      message.style.display = "block";
      return;
    }
    if (next !== confirmValue) {
      message.textContent = "Les deux codes ne correspondent pas.";
      message.style.display = "block";
      return;
    }

    await postUpdatePin(session.personId, next);

    message.style.color = "#28a745";
    message.textContent = "Code mis à jour !";
    message.style.display = "block";
    currentInput.value = "";
    newInput.value = "";
    confirmInput.value = "";
  });
}

// Formulaire partagé "Ma question secrète" : attend les éléments d'id
// security-question-input / security-answer-input / security-question-btn /
// security-question-message sur la page. Pré-remplit la question actuelle
// si déjà définie, pour permettre de la modifier facilement.
function setupSecurityQuestionForm(session, allPeople) {
  const btn = document.getElementById("security-question-btn");
  const questionInput = document.getElementById("security-question-input");
  const answerInput = document.getElementById("security-answer-input");
  const message = document.getElementById("security-question-message");

  if (!btn || !questionInput || !answerInput || !message) return;

  const person = (allPeople || []).find(p => p.id === session.personId);
  if (person && person.question) {
    questionInput.value = person.question;
  }

  btn.addEventListener("click", async () => {
    message.style.display = "none";

    const question = questionInput.value.trim();
    const answer = answerInput.value.trim();

    if (!question || !answer) {
      message.textContent = "Merci de saisir une question et une réponse.";
      message.style.display = "block";
      return;
    }

    await postUpdateSecurityQuestion(session.personId, question, answer);

    message.style.color = "#28a745";
    message.textContent = "Question secrète enregistrée !";
    message.style.display = "block";
    answerInput.value = "";
  });
}

// Formulaire partagé "Mon avatar" : attend les éléments d'id avatar-input /
// avatar-btn / avatar-message sur la page. Un simple champ texte (pas de
// liste imposée) pour que chacun choisisse l'emoji qui lui plaît vraiment.
function setupAvatarForm(session, allPeople) {
  const btn = document.getElementById("avatar-btn");
  const input = document.getElementById("avatar-input");
  const message = document.getElementById("avatar-message");

  if (!btn || !input || !message) return;

  const person = (allPeople || []).find(p => p.id === session.personId);
  input.value = getPersonAvatar(person);

  btn.addEventListener("click", async () => {
    message.style.display = "none";

    const avatar = input.value.trim();
    if (!avatar) {
      message.textContent = "Choisis un emoji.";
      message.style.display = "block";
      return;
    }

    await postUpdateAvatar(session.personId, avatar);

    message.style.color = "#28a745";
    message.textContent = "Avatar enregistré !";
    message.style.display = "block";
  });
}
