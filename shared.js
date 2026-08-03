// Config et helpers partagés entre les 3 pages (index, kids, adults).
const STORAGE_KEY = "corvees-famille-v1";
const API_CONFIG_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/03ec9874-25e6-483b-8305-4f622e53a24a";
const API_REPAS_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/repas-config";
const API_COMPLETE_URL = "https://n8n.srv1105523.hstgr.cloud/webhook/corvees-complete";
// Clé publique VAPID (pas un secret : c'est la clé privée côté n8n qui protège l'envoi).
const VAPID_PUBLIC_KEY = "BJ0GA_Ja776Yrp9YdQPTqJX2TvSMxnyntybgAZUzWG6_cUxnJqaPdvmX1I-H5HmUXZQwTyd5MRtGkSvUnILgYbs";

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

// isAdmin vient de la propriété "Admin" (checkbox) de la personne dans
// Notion, pas d'une liste codée en dur : coche cette case sur n'importe
// quel adulte pour lui donner l'accès complet à la vue adultes.
function setSession(personId, allPeople) {
  const person = (allPeople || []).find(p => p.id === personId);
  const session = { personId, isAdmin: !!(person && person.isAdmin) };
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
  gardeOverrides: {},
  gardeBlocks: [],
  personRoster: [],
  recipes: [],
  mealPlan: [],
  shoppingChecked: [],
  recurringIngredients: [],
  pendingActions: [],
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
const PROPOSAL_GHOST_GRACE_MS = 10 * 60 * 1000;

function mergeById(configItems, localItems) {
  const list = configItems || [];
  const configIds = new Set(list.map(item => item.id));
  const localOnly = (localItems || []).filter(item => {
    if (item._source !== "local" || configIds.has(item.id)) return false;
    // Une proposition (récompense proposée par un enfant, marquée "pending")
    // absente de la config n'est pas forcément "pas encore synchronisée" :
    // Notion peut aussi l'avoir refusée (donc archivée). On ne la garde en
    // local que le temps d'un premier aller-retour réseau ; passé ce délai,
    // son absence dans la config veut dire "refusée", pas "hors ligne".
    if (item.pending) {
      // Fantôme créé avant ce correctif, donc sans horodatage : on ne peut
      // plus savoir depuis quand il traîne, on considère que le délai de
      // grâce est de toute façon dépassé.
      if (!item._localCreatedAt) return false;
      return Date.now() - item._localCreatedAt < PROPOSAL_GHOST_GRACE_MS;
    }
    return true;
  });
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
      gardeOverrides: config.gardeOverrides || {},
      gardeBlocks: config.gardeBlocks || [],
      personRoster: config.personRoster || [],
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

async function fetchRemoteRepasConfig() {
  const res = await fetch(API_REPAS_URL);
  if (!res.ok) throw new Error("API repas non disponible");
  const payload = await res.json();
  return Array.isArray(payload) ? payload[0] : payload;
}

// Chargé séparément de loadAppData(), seulement à l'ouverture de l'onglet
// Repas (ou via son bouton Actualiser) : recettes + ingrédients coûtent à eux
// seuls la moitié des appels Notion nécessaires (327 ingrédients = 4 pages),
// donc on évite de payer ce coût à chaque ouverture de l'appli pour les
// corvées/récompenses/planning garde qui n'en ont pas besoin.
async function loadRepasData() {
  try {
    const config = await fetchRemoteRepasConfig();
    data.recipes = config.recipes || [];
    data.mealPlan = config.mealPlan || [];
    data.shoppingChecked = config.shoppingChecked || [];
    data.recurringIngredients = config.recurringIngredients || [];
    saveData(data);
    return true;
  } catch (e) {
    console.warn("API repas non disponible :", e);
    return false;
  }
}

// --- Indicateur de synchronisation + file d'attente / réessai -----------
// fetch() ne rejette que sur une coupure réseau franche, jamais sur une
// réponse HTTP d'erreur : sans vérifier res.ok, une action pouvait échouer
// côté serveur sans que personne ne le sache jamais (juste un console.warn
// invisible). postToServer() centralise l'écriture vers n8n pour toutes les
// actions ; en cas d'échec (réseau OU HTTP), l'action est mise en attente
// dans data.pendingActions (persisté en localStorage, donc ça survit à un
// rechargement) et réessayée automatiquement — au retour du réseau, et en
// secours toutes les 30s. renderSyncWarningBadge() affiche le nombre
// d'actions en attente tant que la file n'est pas vide.
const syncStatusListeners = [];

function onSyncStatusChange(callback) {
  syncStatusListeners.push(callback);
}

function notifySyncStatus() {
  const count = (data && Array.isArray(data.pendingActions)) ? data.pendingActions.length : 0;
  syncStatusListeners.forEach(cb => cb(count));
}

function enqueuePendingAction(body) {
  if (!data.pendingActions) data.pendingActions = [];
  data.pendingActions.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    body
  });
  saveData(data);
  notifySyncStatus();
}

function dequeuePendingAction(id) {
  if (!data || !Array.isArray(data.pendingActions)) return;
  data.pendingActions = data.pendingActions.filter(item => item.id !== id);
  saveData(data);
}

async function sendOnce(body) {
  try {
    const res = await fetch(API_COMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function postToServer(body) {
  const ok = await sendOnce(body);
  if (ok) {
    notifySyncStatus();
    return true;
  }
  console.warn(`Action "${body.action}" non synchronisée, mise en attente pour réessai :`, body);
  enqueuePendingAction(body);
  return false;
}

// Rejoue les actions en attente dans leur ordre d'échec, et s'arrête au
// premier nouvel échec — pour ne pas rejouer les suivantes dans le désordre
// si le réseau est encore capricieux, elles seront retentées au prochain
// passage.
let retryInFlight = false;
async function retryPendingActions() {
  if (retryInFlight || !data || !Array.isArray(data.pendingActions) || data.pendingActions.length === 0) {
    return;
  }
  retryInFlight = true;
  try {
    while (data.pendingActions.length > 0) {
      const next = data.pendingActions[0];
      const ok = await sendOnce(next.body);
      if (!ok) break;
      dequeuePendingAction(next.id);
    }
  } finally {
    retryInFlight = false;
    notifySyncStatus();
  }
}

window.addEventListener("online", retryPendingActions);
setInterval(retryPendingActions, 30000);

// action: "complete" | "cancel" — un seul webhook, N8N distingue via le champ "action".
async function postChoreAction(personId, choreId, action) {
  return postToServer({
        action,
        personId,
        choreId,
        date: getTodayKey()
      });
}

// action: "purchase" pour l'instant.
async function postRewardAction(personId, rewardId, action) {
  return postToServer({
        action,
        personId,
        rewardId,
        date: getTodayKey()
      });
}

// action: "add_chore" — crée la corvée dans Notion pour qu'elle soit reconnue
// par l'automatisation (et visible depuis les autres appareils). personIds
// est un tableau (une corvée peut être assignée à plusieurs personnes).
// frequency: "quotidien" (défaut) | "hebdomadaire" | "ponctuel" ; weeklyDays
// (tableau de jours, 0=dimanche...6=samedi) n'est utile que pour "hebdomadaire".
async function postAddChore(choreId, label, stars, personIds, frequency, weeklyDays) {
  return postToServer({
        action: "add_chore",
        choreId,
        label,
        stars,
        personIds,
        frequency,
        weeklyDays
      });
}

// action: "update_chore_frequency" — change la fréquence (et les jours, si
// hebdomadaire) d'une corvée existante.
async function postUpdateChoreFrequency(choreId, frequency, weeklyDays) {
  return postToServer({
        action: "update_chore_frequency",
        choreId,
        frequency,
        weeklyDays
      });
}

// action: "update_chore_details" — change le nom et/ou la valeur en étoiles
// d'une corvée existante.
async function postUpdateChoreDetails(choreId, label, stars) {
  return postToServer({
        action: "update_chore_details",
        choreId,
        label,
        stars
      });
}

// action: "update_reward_details" — change le nom et/ou le coût d'une
// récompense existante.
async function postUpdateRewardDetails(rewardId, label, cost) {
  return postToServer({
        action: "update_reward_details",
        rewardId,
        label,
        cost
      });
}

// action: "add_reward" — crée la récompense dans Notion. personIds est un tableau.
async function postAddReward(rewardId, label, cost, personIds) {
  return postToServer({
        action: "add_reward",
        rewardId,
        label,
        cost,
        personIds
      });
}

// action: "propose_reward" — un enfant propose une récompense sans coût ; elle
// reste "en attente" (reward.pending côté config) jusqu'à ce qu'un adulte lui
// attribue un coût via postUpdateRewardCost.
async function postProposeReward(rewardId, label, personId) {
  return postToServer({
        action: "propose_reward",
        rewardId,
        label,
        personId
      });
}

// action: "update_reward_cost" — un adulte attribue un coût à une récompense
// proposée par un enfant, ce qui l'active (elle n'est plus "en attente").
async function postUpdateRewardCost(rewardId, cost) {
  return postToServer({
        action: "update_reward_cost",
        rewardId,
        cost
      });
}

// action: "update_chore_assignment" — remplace la liste de personnes assignées
// à une corvée existante (relation "Assignée à" côté Notion).
async function postUpdateChoreAssignment(choreId, personIds) {
  return postToServer({
        action: "update_chore_assignment",
        choreId,
        personIds
      });
}

// action: "update_reward_assignment" — idem pour une récompense.
async function postUpdateRewardAssignment(rewardId, personIds) {
  return postToServer({
        action: "update_reward_assignment",
        rewardId,
        personIds
      });
}

// action: "delete_reward" — archive la récompense dans Notion.
async function postDeleteReward(rewardId) {
  return postToServer({
        action: "delete_reward",
        rewardId
      });
}

// action: "delete_chore" — archive la corvée dans Notion.
async function postDeleteChore(choreId) {
  return postToServer({
        action: "delete_chore",
        choreId
      });
}

// action: "update_pin" — enregistre le nouveau code de la personne dans Notion.
async function postUpdatePin(personId, newPin) {
  return postToServer({
        action: "update_pin",
        personId,
        newPin
      });
}

// action: "update_security_question" — enregistre la question/réponse secrète
// de la personne dans Notion (utilisée par le flux "Code oublié ?").
async function postUpdateSecurityQuestion(personId, question, answer) {
  return postToServer({
        action: "update_security_question",
        personId,
        question,
        answer
      });
}

// action: "update_avatar" — enregistre l'emoji choisi par la personne dans
// Notion, pour le retrouver sur tous les appareils.
async function postUpdateAvatar(personId, avatar) {
  return postToServer({
        action: "update_avatar",
        personId,
        avatar
      });
}

// Emoji d'une personne, avec un repli neutre si elle n'en a pas encore choisi.
function getPersonAvatar(person) {
  return (person && person.avatar) || "🙂";
}

/* ============================================================
   PLANNING DE GARDE — config à mettre à jour chaque année (dates
   des petites vacances zone B, point de départ des blocs d'été).
   Le calcul se fait ici côté client ; seules les exceptions posées
   à la main par l'admin (gardeOverrides) viennent de Notion.
   ============================================================ */

// Alternance des week-ends "normaux" (hors vacances). Repère : le vendredi
// de cette date-là, le week-end est chez ce parent. Ça alterne ensuite
// chaque semaine.
const GARDE_WEEKEND_ANCHOR = { friday: "2026-06-26", parent: "papa" };

// Domicile habituel de chaque enfant en semaine (hors week-end/vacances).
const GARDE_CHILD_HOME_PARENT = { Roxanne: "maman", Elena: "papa" };

const GARDE_PARENT_DISPLAY = {
  maman: { text: "Chez Maman", emoji: "👩" },
  papa: { text: "Chez Papa", emoji: "👨" }
};

function gardeParseDate(s) {
  const [y, m, day] = s.split("-").map(Number);
  return new Date(y, m - 1, day);
}
function gardeAddDays(date, n) {
  const r = new Date(date);
  r.setDate(r.getDate() + n);
  return r;
}
function gardeDaysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
function gardeDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function gardeSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function gardeOpposite(p) {
  return p === "papa" ? "maman" : "papa";
}

function gardeFridayOfWeek(date) {
  const r = new Date(date);
  const dow = r.getDay();
  if (dow === 5) return r;
  if (dow === 6) return gardeAddDays(r, -1);
  if (dow === 0) return gardeAddDays(r, -2);
  return null;
}

function gardeNormalWeekendParent(date) {
  const fri = gardeFridayOfWeek(date);
  const anchorFri = gardeParseDate(GARDE_WEEKEND_ANCHOR.friday);
  const weeksDiff = Math.round(gardeDaysBetween(anchorFri, fri) / 7);
  const isAnchorParity = (weeksDiff % 2 + 2) % 2 === 0;
  return isAnchorParity ? GARDE_WEEKEND_ANCHOR.parent : gardeOpposite(GARDE_WEEKEND_ANCHOR.parent);
}

// Renvoie { parent: "maman"|"papa"|null, period, label } pour une date
// donnée. parent = null hors week-end/vacances (jour d'école normal,
// dépend du domicile habituel de l'enfant).
// - overrides est la map gardeOverrides ({ "AAAA-MM-JJ": "maman"|"papa" })
//   posée à la main par l'admin (clic sur un jour), qui prend toujours le
//   dessus.
// - blocks est la liste gardeBlocks ({ start, end, parent, label }[]) qui
//   couvre les vacances scolaires (petites et grandes) : chaque bloc est
//   géré depuis Notion via l'appli, pas codé en dur. En dehors de tout
//   bloc, le week-end suit l'alternance normale et la semaine reste au
//   domicile habituel de chaque enfant.
function getSharedGardeLocation(date, overrides, blocks) {
  const key = gardeDateKey(date);
  if (overrides && overrides[key]) {
    return { parent: overrides[key], period: "Modifié", label: "Modifié manuellement", overridden: true };
  }

  const dow = date.getDay();
  const isWeekend = dow === 5 || dow === 6 || dow === 0;

  for (const block of (blocks || [])) {
    const start = gardeParseDate(block.start), end = gardeParseDate(block.end);
    if (date >= start && date <= end) {
      const label = isWeekend && block.label ? `${block.label} (week-end)` : (block.label || "Vacances");
      return { parent: block.parent, period: "Vacances", label };
    }
  }

  if (isWeekend) {
    return { parent: gardeNormalWeekendParent(date), period: "Week-end", label: "Week-end" };
  }
  return { parent: null, period: "Semaine", label: "Semaine (chacune chez son domicile habituel)" };
}

// Position spécifique d'un enfant, qui tient compte de son domicile par
// défaut en semaine (childName = person.name, ex. "Roxanne").
function getChildGardeLocation(childName, date, overrides, blocks) {
  const shared = getSharedGardeLocation(date, overrides, blocks);
  if (shared.parent) return shared;
  const homeParent = GARDE_CHILD_HOME_PARENT[childName];
  if (!homeParent) return { parent: null, period: shared.period, label: shared.label };
  return { parent: homeParent, period: shared.period, label: "Domicile habituel" };
}

// action: "set_garde_override" — force manuellement un jour chez un parent
// (exception au calcul automatique), ex. échange de week-end.
async function postSetGardeOverride(dateKey, parent) {
  return postToServer({ action: "set_garde_override", date: dateKey, parent });
}

// action: "clear_garde_override" — retire une exception posée à la main,
// pour revenir au calcul automatique sur ce jour.
async function postClearGardeOverride(dateKey) {
  return postToServer({ action: "clear_garde_override", date: dateKey });
}

// action: "add_garde_block" — ajoute un bloc de vacances (petites ou
// grandes) dans Notion, pour que l'admin configure les dates de garde
// depuis l'appli sans passer par du code.
async function postAddGardeBlock(label, start, end, parent) {
  return postToServer({ action: "add_garde_block", label, start, end, parent });
}

// action: "delete_garde_block" — supprime un bloc de vacances.
async function postDeleteGardeBlock(blockId) {
  return postToServer({ action: "delete_garde_block", blockId });
}

// action: "update_garde_block" — modifie un bloc de vacances existant
// (nom, dates, parent) directement depuis l'appli.
async function postUpdateGardeBlock(blockId, label, start, end, parent) {
  return postToServer({ action: "update_garde_block", blockId, label, start, end, parent });
}

// action: "add_person" — crée un enfant ou un adulte dans Notion, pour
// gérer la famille depuis l'appli sans passer par Notion directement.
async function postAddPerson(name, type, code) {
  return postToServer({ action: "add_person", name, type, code });
}

// action: "toggle_person_active" — active/désactive une personne (jamais
// de suppression pure, pour ne pas casser les historiques qui la
// référencent encore).
async function postTogglePersonActive(personId, active) {
  return postToServer({ action: "toggle_person_active", personId, active });
}

// action: "set_meal_plan" — assigne (ou remplace) la recette prévue pour un
// jour + créneau (midi/soir) donné. La recette elle-même reste gérée dans
// Notion (BDD RECETTES) : ici on choisit juste laquelle est prévue quand.
async function postSetMealPlan(dateKey, slot, recipeId) {
  return postToServer({ action: "set_meal_plan", date: dateKey, slot, recipeId });
}

// action: "clear_meal_plan" — retire la recette prévue pour un jour + créneau.
async function postClearMealPlan(dateKey, slot) {
  return postToServer({ action: "clear_meal_plan", date: dateKey, slot });
}

// action: "propose_meal" — un enfant suggère une recette pour un jour +
// créneau encore vide ; reste "en attente" (mealPlan[].pending côté config)
// jusqu'à ce qu'un adulte approuve ou refuse la proposition.
async function postProposeMeal(dateKey, slot, recipeId, personId) {
  return postToServer({ action: "propose_meal", date: dateKey, slot, recipeId, personId });
}

// action: "approve_meal_proposal" — un adulte valide la proposition, qui
// devient un menu confirmé normal.
async function postApproveMealProposal(dateKey, slot) {
  return postToServer({ action: "approve_meal_proposal", date: dateKey, slot });
}

// action: "reject_meal_proposal" — un adulte refuse la proposition, qui est
// supprimée.
async function postRejectMealProposal(dateKey, slot) {
  return postToServer({ action: "reject_meal_proposal", date: dateKey, slot });
}

// action: "check_shopping_item" / "uncheck_shopping_item" — coche partagée de
// la liste de courses (une ligne Notion par ingrédient x période affichée),
// pour que les cases cochées soient les mêmes sur tous les appareils.
async function postCheckShoppingItem(periodKey, ingredientId) {
  return postToServer({ action: "check_shopping_item", periodKey, ingredientId });
}

async function postUncheckShoppingItem(periodKey, ingredientId) {
  return postToServer({ action: "uncheck_shopping_item", periodKey, ingredientId });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// action: "save_push_subscription" — enregistre (ou met à jour) l'abonnement
// aux notifications push de cet appareil pour cette personne.
async function postSavePushSubscription(personId, subscription) {
  const json = subscription.toJSON();
  return postToServer({
    action: "save_push_subscription",
    personId,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth
  });
}

// Branche le bouton "🔔 Activer les notifications" partagé (id: enable-push-btn
// + un <p id="push-status">). personId est celui à associer à l'abonnement
// (session.personId côté adultes, data.activeChildId côté enfants).
async function setupPushNotifications(personId) {
  const btn = document.getElementById("enable-push-btn");
  const status = document.getElementById("push-status");
  if (!btn) return;

  // Sur iPhone/iPad, seul Safari a accès aux notifications push pour une PWA,
  // et seulement une fois l'appli ajoutée à l'écran d'accueil (iOS 16.4+) :
  // Chrome/Firefox iOS utilisent le même moteur qu'Safari mais Apple leur
  // bloque cette fonctionnalité. On détecte le cas pour expliquer plutôt que
  // de laisser échouer avec une erreur générique.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);

  if (isIOS && !isStandalone) {
    btn.disabled = true;
    if (!isSafari) {
      status.textContent = "Sur iPhone/iPad, seul Safari permet les notifications (pas Chrome/Firefox). Ouvre ce site avec Safari, puis suis l'étape suivante.";
    } else {
      status.textContent = "Ajoute d'abord l'appli à l'écran d'accueil : appuie sur le bouton Partager, puis \"Sur l'écran d'accueil\". Ouvre ensuite l'appli depuis cette icône pour activer les notifications.";
    }
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.disabled = true;
    btn.textContent = "🔔 Non disponible sur ce navigateur";
    return;
  }

  async function updateButtonState() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        btn.textContent = "🔔 Notifications activées";
        btn.disabled = true;
      } else {
        btn.textContent = "🔔 Activer les notifications";
        btn.disabled = false;
      }
    } catch (e) {
      // Pas grave si l'état ne peut pas être vérifié : le bouton reste cliquable.
    }
  }

  btn.addEventListener("click", async () => {
    const result = await requestPushSubscription(personId);
    if (status) status.textContent = result.message;
    if (result.success) await updateButtonState();
    renderPushReminderBadge(personId);
  });

  updateButtonState();
}

// Cœur de l'activation des notifications, partagé entre le bouton de "Mon
// compte" et le bandeau de rappel (voir renderPushReminderBadge) : demande
// la permission navigateur, crée l'abonnement push, l'enregistre pour
// personId. Renvoie un message à afficher plutôt que de toucher le DOM
// directement, pour que chaque appelant l'affiche à son endroit.
async function requestPushSubscription(personId) {
  if (!personId) return { success: false, message: "Sélectionne d'abord ton profil." };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { success: false, message: "Notifications refusées dans le navigateur." };
    }
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    await postSavePushSubscription(personId, subscription);
    return { success: true, message: "Notifications activées !" };
  } catch (e) {
    console.warn("Erreur activation notifications :", e);
    return { success: false, message: "Erreur lors de l'activation des notifications." };
  }
}

// Bandeau discret proposant d'activer les notifications tant que ce n'est
// pas déjà fait sur cet appareil — sans lui, tout ce qui vient d'être
// construit (rappels, propositions) ne sert à rien si personne n'a jamais
// cliqué sur "Activer" dans Mon compte. Ne s'affiche plus après un refus
// explicite (Notification.permission === "denied"), pour ne pas insister.
async function renderPushReminderBadge(personId) {
  const badge = document.getElementById("push-reminder-badge");
  if (!badge) return;
  if (!personId || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    badge.style.display = "none";
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    badge.style.display = "none";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    badge.style.display = existing ? "none" : "flex";
  } catch (e) {
    badge.style.display = "none";
  }
}

function setupPushReminderBadge(personId) {
  const btn = document.getElementById("push-reminder-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    await requestPushSubscription(personId);
    renderPushReminderBadge(personId);
    // Si le vrai bouton de Mon compte est déjà dans la page (juste dans un
    // sous-onglet masqué), on le remet à jour aussi pour éviter qu'il
    // affiche encore "Activer" une fois qu'on y va.
    const realBtn = document.getElementById("enable-push-btn");
    if (realBtn) {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const existing = reg ? await reg.pushManager.getSubscription() : null;
      if (existing) {
        realBtn.textContent = "🔔 Notifications activées";
        realBtn.disabled = true;
      }
    }
  });
}

// Rendu du calendrier de garde (3 mois, décalables via monthOffset) dans
// container, pour l'enfant childName. Partagé entre adults.html (avec
// clic admin) et kids.html (lecture seule, onCellClick = null).
function renderGardeMonths(container, childName, overrides, blocks, monthOffset, onCellClick) {
  container.innerHTML = "";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dowFmt = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];
  const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
  const firstMonth = new Date(today.getFullYear(), today.getMonth() + (monthOffset || 0), 1);

  for (let m = 0; m < 3; m++) {
    const monthDate = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + m, 1);
    const year = monthDate.getFullYear(), month = monthDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;

    const box = document.createElement("div");
    box.className = "garde-month";

    const title = document.createElement("h3");
    title.textContent = monthFmt.format(monthDate);
    box.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "garde-grid";

    dowFmt.forEach(dw => {
      const cell = document.createElement("div");
      cell.className = "garde-dow";
      cell.textContent = dw;
      grid.appendChild(cell);
    });

    for (let i = 0; i < firstDow; i++) {
      grid.appendChild(document.createElement("div"));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const loc = getChildGardeLocation(childName, dateObj, overrides, blocks);
      const isToday = gardeSameDay(dateObj, today);
      const dateKey = gardeDateKey(dateObj);
      const isForced = !!(overrides && overrides[dateKey]);

      const cell = document.createElement("div");
      cell.title = loc.label;
      cell.className = "garde-cell " + (loc.parent || "none");
      if (isToday) cell.classList.add("today");
      if (loc.overridden) cell.classList.add("overridden");

      const num = document.createElement("span");
      num.textContent = day;
      cell.appendChild(num);

      if (loc.parent) {
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = GARDE_PARENT_DISPLAY[loc.parent].emoji;
        cell.appendChild(who);
      }

      if (onCellClick) {
        cell.classList.add("clickable");
        cell.addEventListener("click", () => onCellClick(dateKey, isForced, overrides && overrides[dateKey]));
      }

      grid.appendChild(cell);
    }

    box.appendChild(grid);
    container.appendChild(box);
  }
}

const MEAL_SLOTS = [
  { value: "Midi", label: "🍛 Midi" },
  { value: "Soir", label: "🥘 Soir" }
];

// Les 7 dates (lundi à dimanche) de la semaine décalée de weekOffset semaines
// par rapport à la semaine en cours (0 = semaine actuelle).
function getWeekDates(weekOffset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7; // 0 = lundi
  const monday = new Date(today);
  monday.setDate(today.getDate() - dow + (weekOffset || 0) * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function findMealPlanEntry(mealPlan, dateKey, slot) {
  return (mealPlan || []).find(m => m.date === dateKey && m.slot === slot);
}

function findRecipeById(recipes, recipeId) {
  return (recipes || []).find(r => r.id === recipeId);
}

// Rend une grille "jour x créneau" pour une semaine de menus. onCellClick
// (dateKey, slot, currentRecipeId, dateObj) est optionnel : le passer rend
// les cases cliquables (vue adulte éditable) ; l'omettre donne une vue
// lecture seule (vue enfant).
// Remplit une case du planning repas (grille semaine ou liste mois) : texte +
// classes + interactions, selon que l'entrée est confirmée, en attente
// (proposée par un enfant) ou vide. onCellClick (adulte) permet de
// choisir/changer n'importe quelle case. onProposeClick (enfant, seulement
// si onCellClick est absent) ne s'applique qu'aux cases vides, pour suggérer
// une recette sans pouvoir écraser un menu déjà confirmé.
function fillMealCell(cell, entry, recipe, dateKey, slot, dateObj, onCellClick, onProposeClick, labelPrefix) {
  const prefix = labelPrefix ? `${labelPrefix} : ` : "";
  const text = document.createElement("span");

  if (recipe && entry && entry.pending) {
    cell.classList.add("pending");
    text.textContent = `${prefix}⏳ ${recipe.name} (proposé)`;
  } else if (recipe) {
    cell.classList.add("filled");
    text.textContent = `${prefix}${recipe.name}`;
  } else {
    text.className = "meal-cell-placeholder";
    text.textContent = `${prefix}${onCellClick || onProposeClick ? "+ Ajouter" : "—"}`;
  }
  cell.appendChild(text);

  if (onCellClick) {
    cell.classList.add("clickable");
    cell.addEventListener("click", () => onCellClick(dateKey, slot, entry ? entry.recipeId : null, dateObj));
  } else if (onProposeClick && !recipe) {
    cell.classList.add("clickable");
    cell.addEventListener("click", () => onProposeClick(dateKey, slot, dateObj));
  }
}

function renderMealPlanWeek(container, recipes, mealPlan, weekOffset, onCellClick, onProposeClick) {
  container.innerHTML = "";
  container.style.overflowX = "auto";

  const dates = getWeekDates(weekOffset || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dowFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });
  const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

  const grid = document.createElement("div");
  grid.className = "meal-grid";

  grid.appendChild(document.createElement("div"));
  dates.forEach(d => {
    const header = document.createElement("div");
    header.className = "meal-day-header" + (gardeSameDay(d, today) ? " today" : "");
    header.textContent = `${dowFmt.format(d)} ${dayFmt.format(d)}`;
    grid.appendChild(header);
  });

  MEAL_SLOTS.forEach(slotDef => {
    const label = document.createElement("div");
    label.className = "meal-slot-label";
    label.textContent = slotDef.label;
    grid.appendChild(label);

    dates.forEach(d => {
      const dateKey = gardeDateKey(d);
      const entry = findMealPlanEntry(mealPlan, dateKey, slotDef.value);
      const recipe = entry ? findRecipeById(recipes, entry.recipeId) : null;

      const cell = document.createElement("div");
      cell.className = "meal-cell" + (gardeSameDay(d, today) ? " today" : "");
      fillMealCell(cell, entry, recipe, dateKey, slotDef.value, d, onCellClick, onProposeClick);

      grid.appendChild(cell);
    });
  });

  container.appendChild(grid);
}

// Tous les jours (du 1er au dernier) du mois décalé de monthOffset mois par
// rapport au mois en cours (0 = mois actuel).
function getMonthDates(monthOffset) {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() + (monthOffset || 0), 1);
  const dates = [];
  const month = first.getMonth();
  const d = new Date(first);
  while (d.getMonth() === month) {
    dates.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Rend une liste "un jour par ligne" (toutes les dates du mois), chaque ligne
// ayant une case par créneau repas. Mêmes conventions que renderMealPlanWeek :
// onCellClick optionnel pour la vue éditable, omis pour la vue lecture seule.
function renderMealPlanMonth(container, recipes, mealPlan, monthOffset, onCellClick, onProposeClick) {
  container.innerHTML = "";

  const dates = getMonthDates(monthOffset || 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dowFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });
  const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

  const list = document.createElement("div");
  list.className = "meal-month-list";

  dates.forEach(d => {
    const dateKey = gardeDateKey(d);
    const row = document.createElement("div");
    row.className = "meal-month-row" + (gardeSameDay(d, today) ? " today" : "");

    const label = document.createElement("div");
    label.className = "meal-month-day";
    label.textContent = `${dowFmt.format(d)} ${dayFmt.format(d)}`;
    row.appendChild(label);

    MEAL_SLOTS.forEach(slotDef => {
      const entry = findMealPlanEntry(mealPlan, dateKey, slotDef.value);
      const recipe = entry ? findRecipeById(recipes, entry.recipeId) : null;

      const cell = document.createElement("div");
      cell.className = "meal-cell meal-month-cell";
      fillMealCell(cell, entry, recipe, dateKey, slotDef.value, d, onCellClick, onProposeClick, slotDef.label);

      row.appendChild(cell);
    });

    list.appendChild(row);
  });

  container.appendChild(list);
}

// Valeurs uniques du champ "Type de repas" présentes dans les recettes,
// triées alphabétiquement, pour peupler le sélecteur de filtre.
function getUniqueMealTypes(recipes) {
  const set = new Set();
  (recipes || []).forEach(r => (r.mealTypes || []).forEach(t => set.add(t)));
  return Array.from(set).sort((a, b) => a.localeCompare(b, "fr"));
}

// Une recette est "faisable maintenant" si tous ses ingrédients sont en stock
// (>0). Une recette sans ingrédients répertoriés n'est pas considérée comme
// faisable (donnée manquante, pas une vraie recette "prête").
function isRecipeMakeable(recipe) {
  const ingredients = recipe.ingredients || [];
  return ingredients.length > 0 && ingredients.every(ing => (ing.inStock || 0) > 0);
}

// Suggère une recette au hasard pour "je sais pas quoi cuisiner" : écarte les
// recettes déjà prévues sur la période affichée (pour varier), en priorité
// parmi celles faisables avec le stock actuel. Si tout est déjà prévu ou rien
// n'est faisable, retombe sur un choix élargi plutôt que de ne rien proposer.
function suggestRandomRecipe(recipes, mealPlan, dateKeys) {
  const keySet = new Set(dateKeys);
  const usedRecipeIds = new Set(
    (mealPlan || [])
      .filter(m => keySet.has(m.date) && !m.pending)
      .map(m => m.recipeId)
  );

  const all = recipes || [];
  const notUsed = all.filter(r => !usedRecipeIds.has(r.id));
  const makeableNotUsed = notUsed.filter(isRecipeMakeable);

  const pool = makeableNotUsed.length > 0 ? makeableNotUsed : notUsed.length > 0 ? notUsed : all;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Rend la liste consultable des recettes (fiche par recette : tags, temps,
// note, lien vers la recette source, ingrédients). filterText optionnel pour
// filtrer par nom, mealTypeFilter optionnel pour filtrer par "Type de repas",
// onlyMakeable optionnel pour ne garder que les recettes faisables avec le
// stock actuel, onPlanClick(recipe) optionnel pour afficher un bouton
// "Planifier" (vue adulte éditable) — omis pour la vue lecture seule.
// Dernière date (YYYY-MM-DD, passée ou aujourd'hui, hors propositions en
// attente) à laquelle chaque recette a été programmée dans le planning —
// contrairement au champ Notion "Dernière fois" (texte libre saisi à la
// main, donc pas fiable pour trier), c'est calculé à partir de mealPlan,
// que l'appli a déjà. undefined si la recette n'a jamais été planifiée.
function computeLastPlannedByRecipeId(mealPlan) {
  const todayKey = getTodayKey();
  const result = {};
  (mealPlan || []).forEach(entry => {
    if (entry.pending || entry.date > todayKey) return;
    if (!result[entry.recipeId] || entry.date > result[entry.recipeId]) {
      result[entry.recipeId] = entry.date;
    }
  });
  return result;
}

function renderRecipesList(container, recipes, filterText, mealTypeFilter, onlyMakeable, onPlanClick, mealPlan, sortStale) {
  container.innerHTML = "";

  const lastPlannedByRecipeId = computeLastPlannedByRecipeId(mealPlan);

  const needle = (filterText || "").trim().toLowerCase();
  let filtered = (recipes || []).filter(r => {
    if (needle && !r.name.toLowerCase().includes(needle)) return false;
    if (mealTypeFilter && !(r.mealTypes || []).includes(mealTypeFilter)) return false;
    if (onlyMakeable && !isRecipeMakeable(r)) return false;
    return true;
  });

  if (sortStale) {
    // Jamais planifiée d'abord, puis la moins récente en premier.
    filtered = [...filtered].sort((a, b) => {
      const da = lastPlannedByRecipeId[a.id] || "";
      const db = lastPlannedByRecipeId[b.id] || "";
      if (da === db) return a.name.localeCompare(b.name, "fr");
      return da < db ? -1 : 1;
    });
  }

  if (filtered.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Aucune recette trouvée.";
    container.appendChild(empty);
    return;
  }

  filtered.forEach(recipe => {
    const card = document.createElement("div");
    card.className = "recipe-card";

    if (recipe.photo) {
      const photo = document.createElement("img");
      photo.className = "recipe-photo";
      photo.src = recipe.photo;
      photo.alt = "";
      photo.loading = "lazy";
      card.appendChild(photo);
    }

    const name = document.createElement("div");
    name.className = "recipe-name";
    name.textContent = recipe.name;
    if (isRecipeMakeable(recipe)) {
      const badge = document.createElement("span");
      badge.className = "recipe-makeable-badge";
      badge.textContent = "✅ Faisable maintenant";
      name.appendChild(badge);
    }
    const lastPlanned = lastPlannedByRecipeId[recipe.id];
    if (!lastPlanned) {
      const staleBadge = document.createElement("span");
      staleBadge.className = "recipe-stale-badge";
      staleBadge.textContent = "🕰️ Jamais planifiée";
      name.appendChild(staleBadge);
    } else {
      const daysSince = Math.round((new Date(getTodayKey()) - new Date(lastPlanned)) / 86400000);
      if (daysSince >= 60) {
        const staleBadge = document.createElement("span");
        staleBadge.className = "recipe-stale-badge";
        staleBadge.textContent = "🕰️ Pas prévue depuis longtemps";
        name.appendChild(staleBadge);
      }
    }
    card.appendChild(name);

    const tags = [...(recipe.mealCategories || []), ...(recipe.mealTypes || [])];
    if (tags.length > 0) {
      const tagsEl = document.createElement("div");
      tagsEl.className = "recipe-tags";
      tagsEl.textContent = tags.join(" · ");
      card.appendChild(tagsEl);
    }

    const metaParts = [];
    const totalMin = (recipe.prepMin || 0) + (recipe.cookMin || 0);
    if (totalMin > 0) metaParts.push(`⏱️ ${totalMin} min`);
    if (recipe.note) metaParts.push(recipe.note);
    if (recipe.lastMade) metaParts.push(`Dernière fois : ${recipe.lastMade}`);
    if (metaParts.length > 0) {
      const metaEl = document.createElement("div");
      metaEl.className = "recipe-meta";
      metaEl.textContent = metaParts.join("  ·  ");
      card.appendChild(metaEl);
    }

    if ((recipe.ingredients || []).length > 0) {
      const ingEl = document.createElement("div");
      ingEl.className = "recipe-ingredients";
      ingEl.textContent = recipe.ingredients.map(i => i.name).join(", ");
      card.appendChild(ingEl);
    }

    if (recipe.link) {
      const linkEl = document.createElement("a");
      linkEl.className = "recipe-link";
      linkEl.href = recipe.link;
      linkEl.target = "_blank";
      linkEl.rel = "noopener noreferrer";
      linkEl.textContent = "Voir la recette ↗";
      card.appendChild(linkEl);
    }

    if (onPlanClick) {
      const planBtn = document.createElement("button");
      planBtn.type = "button";
      planBtn.className = "btn-secondary recipe-plan-btn";
      planBtn.textContent = "📅 Planifier";
      planBtn.addEventListener("click", () => onPlanClick(recipe));
      card.appendChild(planBtn);
    }

    container.appendChild(card);
  });
}

// Cases cochées de la liste de courses, partagées entre tous les adultes via
// Notion (une ligne = coché, l'existence de la ligne fait foi) : chaque
// appareil voit les mêmes coches après rechargement des données.
function isIngredientChecked(shoppingChecked, periodKey, ingredientId) {
  return (shoppingChecked || []).some(c => c.periodKey === periodKey && c.ingredientId === ingredientId);
}

function getShoppingPeriodKey(view, dates) {
  const first = dates[0];
  if (view === "month") {
    return `month-${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`;
  }
  return `week-${gardeDateKey(first)}`;
}

// Construit la liste de courses à partir des menus programmés sur les
// dateKeys données (typiquement la semaine affichée) : union dédupliquée des
// ingrédients de chaque recette prévue, avec les recettes qui les utilisent.
// recurringIngredients (papier toilette, litière...) sont ajoutés en plus,
// indépendamment de tout menu, car à racheter régulièrement.
function computeShoppingList(recipes, mealPlan, dateKeys, recurringIngredients) {
  const keySet = new Set(dateKeys);
  const byIngredient = {};

  (mealPlan || [])
    .filter(entry => keySet.has(entry.date) && !entry.pending)
    .forEach(entry => {
      const recipe = findRecipeById(recipes, entry.recipeId);
      if (!recipe) return;
      (recipe.ingredients || []).forEach(ing => {
        if (!byIngredient[ing.id]) {
          byIngredient[ing.id] = { ...ing, recipes: [], count: 0 };
        }
        byIngredient[ing.id].count += 1;
        if (!byIngredient[ing.id].recipes.includes(recipe.name)) {
          byIngredient[ing.id].recipes.push(recipe.name);
        }
      });
    });

  (recurringIngredients || []).forEach(ing => {
    if (!byIngredient[ing.id]) {
      byIngredient[ing.id] = { ...ing, recipes: [], count: 0 };
    }
    byIngredient[ing.id].recurring = true;
  });

  // "En stock" (même champ que isRecipeMakeable) : déjà à la maison, pas
  // besoin de le racheter. On n'a pas de quantité par recette (juste des
  // occurrences), donc "en stock > 0" veut dire "couvert", pas "combien
  // il en reste à acheter".
  return Object.values(byIngredient)
    .filter(ing => !((ing.inStock || 0) > 0))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// Ordre "rayon de magasin" des sous-catégories, repris de celui déjà défini
// à la main dans Notion (BDD INGREDIENTS > Sous catégorie), pour grouper la
// liste de courses comme le magasin plutôt que par ordre alphabétique.
const SHOPPING_CATEGORY_ORDER = [
  "Fruits & légumes", "Produits laitiers & oeufs", "Céréales", "Viande & poisson",
  "Pâtes / riz / haricots", "En vrac", "Épices & Herbes", "Pain", "Snacks",
  "Condiments", "Conserves", "Boissons chaudes", "Surgelé", "Boissons froides",
  "Réfrigéré", "Pour cuisiner", "Végétarien", "Asiatique", "Animaux de compagnie",
  "Pharmacie", "Droguerie", "Matériel de ménage", "Papiers", "Epicerie sucrée",
  "Autres"
];

// Un ingrédient peut avoir plusieurs sous-catégories (champ multi-select côté
// Notion) : on ne regroupe que sur la première, pour éviter de le faire
// apparaître deux fois dans la liste.
function getShoppingCategoryLabel(item) {
  return (item.subCategory || [])[0] || "Autres";
}

// Regroupe une liste déjà triée (computeShoppingList) par rayon, dans
// l'ordre SHOPPING_CATEGORY_ORDER ; les sous-catégories imprévues (ajoutées
// dans Notion depuis) atterrissent à la fin plutôt que de disparaître.
function groupShoppingListByCategory(items) {
  const groups = {};
  (items || []).forEach(item => {
    const cat = getShoppingCategoryLabel(item);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  });
  const orderedCats = [
    ...SHOPPING_CATEGORY_ORDER.filter(cat => groups[cat]),
    ...Object.keys(groups).filter(cat => !SHOPPING_CATEGORY_ORDER.includes(cat))
  ];
  return orderedCats.map(cat => ({ category: cat, items: groups[cat] }));
}

// Petite étoile qui "pop" et s'envole au-dessus de anchorEl (le bouton
// "Valider" cliqué), purement décoratif.
function showStarPop(anchorEl, text) {
  if (!anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const span = document.createElement("span");
  span.className = "star-pop";
  span.textContent = text || "⭐";
  span.style.left = `${rect.left + rect.width / 2}px`;
  span.style.top = `${rect.top}px`;
  document.body.appendChild(span);
  setTimeout(() => span.remove(), 950);
}

// Petite pluie de confettis, déclenchée à l'achat d'une récompense.
function showConfetti() {
  const colors = ["#F76E9C", "#6C5CE7", "#F5A623", "#22C55E", "#4A90E2"];
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.setProperty("--confetti-x", (Math.random() * 80 - 40) + "px");
    piece.style.setProperty("--confetti-r", (Math.random() * 360) + "deg");
    piece.style.animationDelay = (Math.random() * 0.2) + "s";
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 1400);
  }
}

// Petit graphique en barres (SVG, sans librairie) des étoiles gagnées par
// jour pour une personne, à partir de choreHistory (30 corvées les plus
// récentes tous enfants confondus, donc la fenêtre visible dépend de
// l'activité générale de la famille, pas d'une plage de dates fixe).
function renderStarsChart(container, choreHistory, personId) {
  if (!container) return;
  container.innerHTML = "";

  const byDate = {};
  (choreHistory || []).forEach(entry => {
    if (entry.personId !== personId) return;
    const day = (entry.date || "").slice(0, 10);
    if (!day) return;
    byDate[day] = (byDate[day] || 0) + (entry.stars || 0);
  });

  const days = Object.keys(byDate).sort();
  if (days.length === 0) {
    container.innerHTML = '<p class="small">Pas encore assez d\'historique pour un graphique.</p>';
    return;
  }

  const max = Math.max(...days.map(d => byDate[d]), 1);
  const width = 320, height = 110, chartBottom = 90, gap = 4;
  const barWidth = Math.max(6, (width - gap * (days.length - 1)) / days.length);
  const showLabelEvery = days.length > 10 ? Math.ceil(days.length / 10) : 1;

  let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%; height:110px;">`;
  days.forEach((day, i) => {
    const value = byDate[day];
    const barHeight = Math.max(2, (value / max) * (chartBottom - 10));
    const x = i * (barWidth + gap);
    const y = chartBottom - barHeight;
    const dateLabel = new Date(day + "T00:00:00").toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="#6C5CE7"><title>${dateLabel} : ${value}⭐</title></rect>`;
    svg += `<text x="${x + barWidth / 2}" y="${y - 3}" font-size="9" text-anchor="middle" fill="#8A84A6">${value}</text>`;
    if (i % showLabelEvery === 0) {
      svg += `<text x="${x + barWidth / 2}" y="${chartBottom + 12}" font-size="8" text-anchor="middle" fill="#8A84A6">${dateLabel}</text>`;
    }
  });
  svg += `</svg>`;

  container.innerHTML = svg;
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
function setupTabs(defaultTab, onActivate) {
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));

  function activate(tabName) {
    buttons.forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabName));
    panels.forEach(panel => panel.classList.toggle("active", panel.id === `tab-${tabName}`));
    if (onActivate) onActivate(tabName);
  }

  buttons.forEach(btn => {
    btn.addEventListener("click", () => activate(btn.dataset.tab));
  });

  if (buttons.length > 0) {
    activate(defaultTab || buttons[0].dataset.tab);
  }
}

// Sous-navigation générique à l'intérieur d'un onglet principal (regroupe
// plusieurs anciens onglets par thème, ex. Corvées/Récompenses/Récap sous
// "⭐ Corvées") : même esprit que setupTabs() mais scopée à containerEl via
// [data-subtab]/[data-subpanel], pour ne pas entrer en collision avec la
// navigation principale ni avec une autre sous-nav sur la même page.
function setupSubTabs(containerEl, defaultSub, onActivate) {
  if (!containerEl) return;
  const buttons = Array.from(containerEl.querySelectorAll("[data-subtab]"));
  const panels = Array.from(containerEl.querySelectorAll("[data-subpanel]"));
  if (buttons.length === 0) return;

  function activate(name) {
    buttons.forEach(btn => {
      const isActive = btn.dataset.subtab === name;
      btn.classList.toggle("btn-primary", isActive);
      btn.classList.toggle("btn-secondary", !isActive);
    });
    panels.forEach(panel => {
      panel.style.display = panel.dataset.subpanel === name ? "" : "none";
    });
    if (onActivate) onActivate(name);
  }

  buttons.forEach(btn => {
    btn.addEventListener("click", () => activate(btn.dataset.subtab));
  });

  activate(defaultSub || buttons[0].dataset.subtab);
}

// Affiche/masque un bandeau "hors-ligne" si l'API de config n'a pas répondu.
function renderOfflineBadge(data) {
  const badge = document.getElementById("offline-badge");
  if (!badge) return;
  badge.style.display = data.offline ? "block" : "none";
}

// Affiche/masque un bandeau quand une action (valider une corvée, proposer
// un repas...) n'a pas pu s'enregistrer sur le serveur — voir postToServer().
// Branché une fois pour toutes ici : chaque page n'a qu'à ajouter la div.
function renderSyncWarningBadge(count) {
  const badge = document.getElementById("sync-warning-badge");
  if (!badge) return;
  if (count > 0) {
    badge.style.display = "block";
    badge.textContent = count === 1
      ? "⚠️ 1 action en attente de synchronisation. Nouvel essai automatique en cours…"
      : `⚠️ ${count} actions en attente de synchronisation. Nouvel essai automatique en cours…`;
  } else {
    badge.style.display = "none";
  }
}
onSyncStatusChange(renderSyncWarningBadge);

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
