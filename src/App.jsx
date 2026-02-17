import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Protein Floor Tracker (Mary Edition) - v3 Data Safe Edition
 * Storage hardening:
 * - Hydration guard: don't save until we load existing state
 * - Dual-write backup key
 * - Rolling snapshots
 * - Refuse "sudden wipe" (entries -> []) unless user explicitly confirms
 */

const LS_KEY = "protein_floor_tracker_v2";
const LS_BACKUP_KEY = "protein_floor_tracker_v2__backup";
const LS_SNAPSHOTS_KEY = "protein_floor_tracker_v2__snapshots";
const SNAPSHOT_KEEP = 12;

// ---------- helpers ----------
function isoNow() {
  return new Date().toISOString();
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function sameISODate(isoA, isoDate) {
  return isoA.slice(0, 10) === isoDate;
}
function round1(x) {
  return Math.round((x + Number.EPSILON) * 10) / 10;
}
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}
function makeMacro({ calories = 0, protein = 0, carbs = 0, fat = 0 }) {
  return {
    calories: safeNum(calories),
    protein: safeNum(protein),
    carbs: safeNum(carbs),
    fat: safeNum(fat),
  };
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function startOfWeek(date = new Date()) {
  // Monday-based week
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0=Mon
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

// ---------- Open Food Facts ----------
async function offLookupByBarcode(barcode) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
    barcode
  )}.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Open Food Facts lookup failed");
  const j = await r.json();
  if (!j.product) return null;

  const p = j.product;
  const nutr = p.nutriments || {};

  const calories_serv =
    nutr["energy-kcal_serving"] ?? nutr["energy-kcal_value"] ?? 0;
  const protein_serv = nutr["proteins_serving"] ?? nutr["proteins_value"] ?? 0;
  const carbs_serv =
    nutr["carbohydrates_serving"] ?? nutr["carbohydrates_value"] ?? 0;
  const fat_serv = nutr["fat_serving"] ?? nutr["fat_value"] ?? 0;

  const servingSize =
    p.serving_size ||
    (p.product_quantity ? `${p.product_quantity}g` : "1 serving");

  return {
    id: `off:${barcode}`,
    source: "Open Food Facts",
    name: p.product_name || p.generic_name || "Unknown item",
    servingSizeLabel: servingSize,
    macrosPerServing: makeMacro({
      calories: calories_serv,
      protein: protein_serv,
      carbs: carbs_serv,
      fat: fat_serv,
    }),
  };
}

async function offSearch(query) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
    query
  )}&search_simple=1&action=process&json=1&page_size=12`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Open Food Facts search failed");
  const j = await r.json();
  const products = j.products || [];

  return products.slice(0, 12).map((p) => {
    const nutr = p.nutriments || {};
    const calories_serv =
      nutr["energy-kcal_serving"] ?? nutr["energy-kcal_value"] ?? 0;
    const protein_serv =
      nutr["proteins_serving"] ?? nutr["proteins_value"] ?? 0;
    const carbs_serv =
      nutr["carbohydrates_serving"] ?? nutr["carbohydrates_value"] ?? 0;
    const fat_serv = nutr["fat_serving"] ?? nutr["fat_value"] ?? 0;

    return {
      id: `off:${p.code || p._id || Math.random().toString(36).slice(2)}`,
      source: "Open Food Facts",
      name: p.product_name || p.generic_name || "Unknown item",
      servingSizeLabel: p.serving_size || "1 serving",
      macrosPerServing: makeMacro({
        calories: calories_serv,
        protein: protein_serv,
        carbs: carbs_serv,
        fat: fat_serv,
      }),
      barcode: p.code,
    };
  });
}

// ---------- USDA FDC (optional) ----------
async function usdaSearch(query, apiKey) {
  if (!apiKey) return [];
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(
    apiKey
  )}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, pageSize: 10 }),
  });
  if (!r.ok) throw new Error("USDA search failed");
  const j = await r.json();
  const foods = j.foods || [];

  return foods.slice(0, 10).map((f) => {
    const nutrients = f.foodNutrients || [];
    const find = (needle) => {
      const n = nutrients.find((x) =>
        (x.nutrientName || "").toLowerCase().includes(needle)
      );
      return n ? n.value : 0;
    };

    const calories = find("energy") || find("calories");
    const protein = find("protein");
    const carbs = find("carbohydrate");
    const fat = find("total lipid") || find("fat");

    return {
      id: `usda:${f.fdcId}`,
      source: "USDA FDC",
      name: f.description || "USDA item",
      servingSizeLabel: "100g (USDA default)",
      macrosPerServing: makeMacro({ calories, protein, carbs, fat }),
    };
  });
}

// ---------- UI constants ----------
const MEAL_TAGS = ["Breakfast", "Lunch", "Dinner", "Snack"];

const DEFAULT_QUICK_ADDS = [
  {
    name: "Core Power Strawberry (42g protein)",
    servingSizeLabel: "1 bottle",
    macrosPerServing: makeMacro({ calories: 0, protein: 42, carbs: 8, fat: 0 }),
  },
  {
    name: "Egg",
    servingSizeLabel: "1 large",
    macrosPerServing: makeMacro({ calories: 70, protein: 6, carbs: 0.4, fat: 5 }),
  },
  {
    name: "Greek yogurt (plain)",
    servingSizeLabel: "170g",
    macrosPerServing: makeMacro({ calories: 100, protein: 17, carbs: 6, fat: 0 }),
  },
  {
    name: "Chicken breast",
    servingSizeLabel: "100g",
    macrosPerServing: makeMacro({
      calories: 165,
      protein: 31,
      carbs: 0,
      fat: 3.6,
    }),
  },
];

// ---------- storage safety ----------
function makeStatePayload({ proteinFloor, usdaApiKey, entries, roadTripMode, quickAdds }) {
  return {
    version: 3,
    savedAt: isoNow(),
    proteinFloor,
    usdaApiKey,
    entries,
    roadTripMode,
    quickAdds,
  };
}

function appendSnapshot(payload) {
  const snaps = loadJSON(LS_SNAPSHOTS_KEY) || [];
  const next = [{ ts: Date.now(), payload }, ...snaps].slice(0, SNAPSHOT_KEEP);
  saveJSON(LS_SNAPSHOTS_KEY, next);
}

// ---------- App ----------
export default function App() {
  // Settings
  const [proteinFloor, setProteinFloor] = useState(90);
  const [usdaApiKey, setUsdaApiKey] = useState("");
  const [roadTripMode, setRoadTripMode] = useState(false);

  // Tabs: today | add | quickadds | settings | report
  const [tab, setTab] = useState("today");

  // Logging
  const [entries, setEntries] = useState([]);
  const [quickAdds, setQuickAdds] = useState(DEFAULT_QUICK_ADDS);

  // Custom foods
  const [customOpen, setCustomOpen] = useState(false);
  const [customSaveToQuickAdds, setCustomSaveToQuickAdds] = useState(true);
  const [customName, setCustomName] = useState("");
  const [customServing, setCustomServing] = useState("1 serving");
  const [customCalories, setCustomCalories] = useState("");
  const [customProtein, setCustomProtein] = useState("");
  const [customCarbs, setCustomCarbs] = useState("");
  const [customFat, setCustomFat] = useState("");

  // Manage quick adds
  const [qaName, setQaName] = useState("");
  const [qaServing, setQaServing] = useState("1 serving");
  const [qaCalories, setQaCalories] = useState("");
  const [qaProtein, setQaProtein] = useState("");
  const [qaCarbs, setQaCarbs] = useState("");
  const [qaFat, setQaFat] = useState("");
  const [qaEditIndex, setQaEditIndex] = useState(null);

  // Search/lookup
  const [barcode, setBarcode] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);

  // Add form
  const [qty, setQty] = useState(1);
  const [mealTag, setMealTag] = useState("Snack");

  // Status + report
  const [status, setStatus] = useState("");
  const [report, setReport] = useState(null);

  // Snapshots UI
  const [snapshots, setSnapshots] = useState(() => loadJSON(LS_SNAPSHOTS_KEY) || []);

  // Camera scanning
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerStatus, setScannerStatus] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);

  // Safety refs
  const hydratedRef = useRef(false);
  const allowNextEmptySaveRef = useRef(false);
  const lastSavedEntriesLenRef = useRef(0);
  const snapshotTickRef = useRef(0);

  // Load persisted state (primary, then backup)
  useEffect(() => {
    const primary = loadJSON(LS_KEY);
    const backup = loadJSON(LS_BACKUP_KEY);

    const s = primary || backup;
    if (s) {
      setProteinFloor(s.proteinFloor ?? 90);
      setUsdaApiKey(s.usdaApiKey ?? "");
      setEntries(Array.isArray(s.entries) ? s.entries : []);
      setRoadTripMode(Boolean(s.roadTripMode));
      setQuickAdds(Array.isArray(s.quickAdds) ? s.quickAdds : DEFAULT_QUICK_ADDS);

      lastSavedEntriesLenRef.current = Array.isArray(s.entries) ? s.entries.length : 0;

      if (!primary && backup) {
        setStatus("Loaded from backup storage (primary missing).");
      }
    } else {
      setStatus("No saved data found yet (fresh start).");
    }

    hydratedRef.current = true;
    setSnapshots(loadJSON(LS_SNAPSHOTS_KEY) || []);
  }, []);

  // Persist state (with safety seatbelts)
  useEffect(() => {
    if (!hydratedRef.current) return;

    const payload = makeStatePayload({
      proteinFloor,
      usdaApiKey,
      entries,
      roadTripMode,
      quickAdds,
    });

    const prevLen = lastSavedEntriesLenRef.current;
    const nextLen = Array.isArray(entries) ? entries.length : 0;

    // Anti-wipe: refuse to overwrite non-empty history with empty unless explicitly allowed
    if (prevLen > 0 && nextLen === 0 && !allowNextEmptySaveRef.current) {
      setStatus(
        "Safety stop: refused to overwrite your saved log with an empty log. If you intended to wipe, use the 'Wipe all data' button in Settings."
      );
      return;
    }

    allowNextEmptySaveRef.current = false;

    try {
      saveJSON(LS_KEY, payload);
      saveJSON(LS_BACKUP_KEY, payload);

      // Snapshot occasionally: on any entries change, but cap frequency
      // This avoids writing snapshots on every tiny keystroke elsewhere.
      const tick = snapshotTickRef.current + 1;
      snapshotTickRef.current = tick;
      if (tick % 2 === 0 || nextLen !== prevLen) {
        appendSnapshot(payload);
        setSnapshots(loadJSON(LS_SNAPSHOTS_KEY) || []);
      }

      lastSavedEntriesLenRef.current = nextLen;
    } catch {
      setStatus("Save error: local storage may be full or blocked.");
    }
  }, [proteinFloor, usdaApiKey, entries, roadTripMode, quickAdds]);

  const today = useMemo(() => todayISO(), []);
  const todaysEntries = useMemo(
    () => entries.filter((e) => sameISODate(e.createdAt, today)),
    [entries, today]
  );

  const proteinToday = useMemo(() => {
    return round1(
      todaysEntries.reduce(
        (sum, e) => sum + safeNum(e.macros?.protein) * safeNum(e.qty),
        0
      )
    );
  }, [todaysEntries]);

  const floorProgress = useMemo(() => {
    if (proteinFloor <= 0) return 0;
    return Math.min(1, proteinToday / proteinFloor);
  }, [proteinToday, proteinFloor]);

  // ---------- Quick Adds management ----------
  function resetQuickAddForm() {
    setQaName("");
    setQaServing("1 serving");
    setQaCalories("");
    setQaProtein("");
    setQaCarbs("");
    setQaFat("");
    setQaEditIndex(null);
  }

  function startEditQuickAdd(index) {
    const item = quickAdds[index];
    if (!item) return;

    setQaName(item.name ?? "");
    setQaServing(item.servingSizeLabel ?? "1 serving");
    setQaCalories(item.macrosPerServing?.calories ?? "");
    setQaProtein(item.macrosPerServing?.protein ?? "");
    setQaCarbs(item.macrosPerServing?.carbs ?? "");
    setQaFat(item.macrosPerServing?.fat ?? "");
    setQaEditIndex(index);
    setTab("quickadds");
  }

  function saveQuickAdd() {
    const name = qaName.trim();
    if (!name) {
      setStatus("Quick Add needs a name.");
      return;
    }

    const newItem = {
      name,
      servingSizeLabel: qaServing.trim() || "1 serving",
      macrosPerServing: makeMacro({
        calories: qaCalories,
        protein: qaProtein,
        carbs: qaCarbs,
        fat: qaFat,
      }),
    };

    setQuickAdds((prev) => {
      if (qaEditIndex === null) {
        const exists = prev.some(
          (p) => (p.name || "").toLowerCase() === name.toLowerCase()
        );
        if (exists) {
          setStatus("That Quick Add already exists (same name). Edit it instead.");
          return prev;
        }
        setStatus("Quick Add added.");
        return [newItem, ...prev];
      }
      setStatus("Quick Add updated.");
      return prev.map((item, idx) => (idx === qaEditIndex ? newItem : item));
    });

    resetQuickAddForm();
  }

  function deleteQuickAdd(index) {
    setQuickAdds((prev) => prev.filter((_, idx) => idx !== index));
    setStatus("Quick Add deleted.");
    if (qaEditIndex === index) resetQuickAddForm();
  }

  // ---------- Entries ----------
  function addEntry({ name, source, servingSizeLabel, macrosPerServing, qty, mealTag }) {
    const entry = {
      id: `${source}:${Math.random().toString(36).slice(2)}`,
      createdAt: isoNow(),
      name,
      source,
      servingSizeLabel,
      qty: safeNum(qty) || 1,
      macros: macrosPerServing,
      mealTag,
    };
    setEntries((prev) => [entry, ...prev]);
    setStatus("Added.");
  }

  function deleteEntry(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function updateEntryQty(id, newQty) {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, qty: safeNum(newQty) } : e))
    );
  }

  // ---------- Custom Foods ----------
  function addCustomFood() {
    const name = customName.trim();
    if (!name) {
      setStatus("Custom food needs a name.");
      return;
    }

    const item = {
      name,
      servingSizeLabel: customServing.trim() || "1 serving",
      macrosPerServing: makeMacro({
        calories: customCalories,
        protein: customProtein,
        carbs: customCarbs,
        fat: customFat,
      }),
    };

    addEntry({
      name: item.name,
      source: "Custom",
      servingSizeLabel: item.servingSizeLabel,
      macrosPerServing: item.macrosPerServing,
      qty,
      mealTag,
    });

    if (customSaveToQuickAdds) {
      setQuickAdds((prev) => {
        const exists = prev.some(
          (p) => (p.name || "").toLowerCase() === item.name.toLowerCase()
        );
        return exists ? prev : [item, ...prev];
      });
    }

    setCustomName("");
    setCustomServing("1 serving");
    setCustomCalories("");
    setCustomProtein("");
    setCustomCarbs("");
    setCustomFat("");
    setCustomSaveToQuickAdds(true);
    setCustomOpen(false);
    setTab("today");
  }

  // ---------- Backup export/import ----------
  function exportDataJSON() {
    const payload = makeStatePayload({
      proteinFloor,
      usdaApiKey,
      entries,
      roadTripMode,
      quickAdds,
    });

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `protein_floor_backup_${todayISO()}.json`;
    a.click();

    URL.revokeObjectURL(url);
  }

  async function importDataJSON(file) {
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data || !Array.isArray(data.entries)) {
        throw new Error("That file doesn't look like a valid backup.");
      }

      setProteinFloor(Number(data.proteinFloor ?? 90));
      setUsdaApiKey(String(data.usdaApiKey ?? ""));
      setRoadTripMode(Boolean(data.roadTripMode));
      setQuickAdds(Array.isArray(data.quickAdds) ? data.quickAdds : DEFAULT_QUICK_ADDS);
      setEntries(data.entries);

      setStatus("Import complete.");
      setTab("today");
    } catch (e) {
      setStatus(`Import failed: ${e.message}`);
    }
  }

  // ---------- Food lookup/search ----------
  async function handleBarcodeLookup(code) {
    const bc = (code ?? barcode).trim();
    if (!bc) return;
    setStatus("Looking up barcode…");
    setResults([]);
    setSelected(null);

    try {
      const item = await offLookupByBarcode(bc);
      if (!item) {
        setStatus("No barcode match found.");
        return;
      }
      setResults([item]);
      setStatus("Found 1 item.");
      setTab("add");
    } catch (e) {
      setStatus(`Barcode lookup error: ${e.message}`);
    }
  }

  async function handleSearch() {
    const q = query.trim();
    if (!q) return;
    setStatus("Searching…");
    setResults([]);
    setSelected(null);

    try {
      const [off, usda] = await Promise.all([
        offSearch(q),
        usdaSearch(q, usdaApiKey.trim()),
      ]);
      const merged = [...off, ...usda];
      setResults(merged);
      setStatus(`Found ${merged.length} results.`);
    } catch (e) {
      setStatus(`Search error: ${e.message}`);
    }
  }

  function addSelectedToLog() {
    if (!selected) return;
    addEntry({
      name: selected.name,
      source: selected.source,
      servingSizeLabel: selected.servingSizeLabel,
      macrosPerServing: selected.macrosPerServing,
      qty,
      mealTag,
    });
    setSelected(null);
    setQty(1);
    setTab("today");
  }

  function quickAdd(item, tag) {
    addEntry({
      name: item.name,
      source: "Quick Add",
      servingSizeLabel: item.servingSizeLabel,
      macrosPerServing: item.macrosPerServing,
      qty: 1,
      mealTag: tag ?? "Snack",
    });
  }

  // ---------- Weekly report ----------
  function generateWeeklyReport() {
    const sow = startOfWeek(new Date());
    const startISO = sow.toISOString().slice(0, 10);
    const end = new Date(sow);
    end.setDate(end.getDate() + 7);
    const endISO = end.toISOString().slice(0, 10);

    const weekEntries = entries.filter((e) => {
      const d = (e.createdAt || "").slice(0, 10);
      return d >= startISO && d < endISO;
    });

    const byDay = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(sow);
      d.setDate(d.getDate() + i);
      byDay[d.toISOString().slice(0, 10)] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    }

    weekEntries.forEach((e) => {
      const d = (e.createdAt || "").slice(0, 10);
      if (!byDay[d]) byDay[d] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
      byDay[d].calories += safeNum(e.macros?.calories) * safeNum(e.qty);
      byDay[d].protein += safeNum(e.macros?.protein) * safeNum(e.qty);
      byDay[d].carbs += safeNum(e.macros?.carbs) * safeNum(e.qty);
      byDay[d].fat += safeNum(e.macros?.fat) * safeNum(e.qty);
    });

    const dayRows = Object.entries(byDay).map(([date, m]) => ({
      date,
      calories: round1(m.calories),
      protein: round1(m.protein),
      carbs: round1(m.carbs),
      fat: round1(m.fat),
    }));

    const totals = dayRows.reduce(
      (acc, r) => ({
        calories: acc.calories + r.calories,
        protein: acc.protein + r.protein,
        carbs: acc.carbs + r.carbs,
        fat: acc.fat + r.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );

    const reportObj = {
      startISO,
      endISO,
      totals: {
        calories: round1(totals.calories),
        protein: round1(totals.protein),
        carbs: round1(totals.carbs),
        fat: round1(totals.fat),
      },
      averages: {
        calories: round1(totals.calories / 7),
        protein: round1(totals.protein / 7),
        carbs: round1(totals.carbs / 7),
        fat: round1(totals.fat / 7),
      },
      dayRows,
      entryCount: weekEntries.length,
    };

    setReport(reportObj);
    setTab("report");
  }

  function exportReportCSV() {
    if (!report) return;
    const header = "date,calories,protein,carbs,fat\n";
    const lines = report.dayRows
      .map((r) => `${r.date},${r.calories},${r.protein},${r.carbs},${r.fat}`)
      .join("\n");
    const blob = new Blob([header + lines], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weekly_report_${report.startISO}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Snapshots restore ----------
  function restoreSnapshot(idx) {
    const snaps = loadJSON(LS_SNAPSHOTS_KEY) || [];
    const snap = snaps[idx];
    if (!snap?.payload) return;

    const ok = confirm(
      `Restore snapshot from ${new Date(snap.ts).toLocaleString()}?\n\nThis will replace current data in the app.`
    );
    if (!ok) return;

    const p = snap.payload;
    setProteinFloor(Number(p.proteinFloor ?? 90));
    setUsdaApiKey(String(p.usdaApiKey ?? ""));
    setRoadTripMode(Boolean(p.roadTripMode));
    setQuickAdds(Array.isArray(p.quickAdds) ? p.quickAdds : DEFAULT_QUICK_ADDS);
    setEntries(Array.isArray(p.entries) ? p.entries : []);
    setStatus("Snapshot restored.");
    setTab("today");
  }

  function wipeAllData() {
    const ok = confirm(
      "Wipe ALL data on this device for this app?\n\nThis clears entries and quick adds and overwrites saved storage.\n\n(You can export a backup first in Settings.)"
    );
    if (!ok) return;

    // Allow the "empty entries" save exactly once
    allowNextEmptySaveRef.current = true;

    setEntries([]);
    setQuickAdds(DEFAULT_QUICK_ADDS);
    setProteinFloor(90);
    setUsdaApiKey("");
    setRoadTripMode(false);

    setStatus("All data wiped (fresh start).");
    setTab("today");
  }

  // ---------- Camera barcode scanning ----------
  const barcodeDetectorSupported = useMemo(() => {
    return typeof window !== "undefined" && "BarcodeDetector" in window;
  }, []);

  async function openScanner() {
    setScannerStatus("");
    setScannerOpen(true);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setScannerStatus("Camera not available in this browser.");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      if (!barcodeDetectorSupported) {
        setScannerStatus(
          "BarcodeDetector not supported here. You can still type the barcode manually."
        );
        return;
      }

      const detector = new window.BarcodeDetector({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
      });

      scanIntervalRef.current = window.setInterval(async () => {
        try {
          if (!videoRef.current) return;
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes?.length) {
            const raw = barcodes[0].rawValue;
            if (raw) {
              setScannerStatus(`Scanned: ${raw}`);
              closeScanner();
              setBarcode(raw);
              await handleBarcodeLookup(raw);
            }
          }
        } catch {
          // ignore transient detect errors
        }
      }, 500);

      setScannerStatus("Point camera at barcode…");
    } catch (e) {
      setScannerStatus(`Camera error: ${e.message}`);
    }
  }

  function closeScanner() {
    setScannerOpen(false);
    setScannerStatus("");
    if (scanIntervalRef.current) {
      window.clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  useEffect(() => {
    return () => closeScanner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- UI ----------
  return (
    <div
      style={{
        maxWidth: 980,
        margin: "24px auto",
        padding: 16,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 6 }}>Protein Floor Tracker</h1>
      <div style={{ opacity: 0.75, marginBottom: 16 }}>
        Floor-only logging. No grades. Now with data seatbelts.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button onClick={() => setTab("today")} disabled={tab === "today"}>
          Today
        </button>
        <button onClick={() => setTab("add")} disabled={tab === "add"}>
          Add Food
        </button>
        <button onClick={() => setTab("quickadds")} disabled={tab === "quickadds"}>
          Manage Quick Adds
        </button>
        <button onClick={() => setTab("settings")} disabled={tab === "settings"}>
          Settings
        </button>
        <button onClick={generateWeeklyReport}>Generate Weekly Report</button>
      </div>

      {(status || "").trim() && (
        <div style={{ marginBottom: 12, opacity: 0.85 }}>
          {status}
        </div>
      )}

      {tab === "today" && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 18, marginBottom: 6 }}>
                  {roadTripMode ? (
                    <strong>Road Trip Mode: totals hidden</strong>
                  ) : (
                    <>
                      Protein today: <strong>{proteinToday}g</strong> / {proteinFloor}g
                    </>
                  )}
                </div>

                {!roadTripMode && (
                  <div style={{ height: 10, background: "#eee", borderRadius: 999 }}>
                    <div
                      style={{
                        width: `${Math.round(floorProgress * 100)}%`,
                        height: "100%",
                        background: "#999",
                        borderRadius: 999,
                      }}
                    />
                  </div>
                )}
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={roadTripMode}
                  onChange={(e) => setRoadTripMode(e.target.checked)}
                />
                Road Trip Mode
              </label>
            </div>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Quick add</h2>
            {quickAdds.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No quick adds yet.</div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {quickAdds.map((q, idx) => (
                  <button key={`${q.name}-${idx}`} onClick={() => quickAdd(q, "Snack")}>
                    {q.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Today’s log</h2>
            {todaysEntries.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No entries yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {todaysEntries.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 280 }}>
                      <div>
                        <strong>{e.name}</strong>{" "}
                        <span style={{ opacity: 0.6 }}>
                          ({e.source}) • {e.mealTag}
                        </span>
                      </div>

                      <div style={{ opacity: 0.75, fontSize: 13 }}>
                        Qty{" "}
                        <input
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={e.qty}
                          onChange={(ev) => updateEntryQty(e.id, ev.target.value)}
                          style={{ width: 80, padding: 4, margin: "0 6px" }}
                        />
                        × {e.servingSizeLabel}
                        {!roadTripMode && (
                          <> | Protein {round1(e.macros?.protein ?? 0)}g per unit</>
                        )}
                      </div>
                    </div>

                    <button onClick={() => deleteEntry(e.id)}>Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "add" && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Scan barcode (camera)</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={openScanner}>Open Scanner</button>
              <div style={{ opacity: 0.75, fontSize: 13 }}>
                {barcodeDetectorSupported
                  ? "Uses built-in barcode detection if your browser supports it."
                  : "Some browsers don’t support barcode detection. Manual entry still works."}
              </div>
            </div>

            {scannerOpen && (
              <div style={{ marginTop: 12 }}>
                <video
                  ref={videoRef}
                  style={{
                    width: "100%",
                    maxWidth: 520,
                    borderRadius: 12,
                    border: "1px solid #eee",
                  }}
                  muted
                  playsInline
                />
                <div style={{ marginTop: 8, opacity: 0.8 }}>{scannerStatus}</div>
                <button style={{ marginTop: 8 }} onClick={closeScanner}>
                  Close Scanner
                </button>
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Custom food (enter macros)</h2>
            <button onClick={() => setCustomOpen((v) => !v)}>
              {customOpen ? "Close Custom Food" : "Add Custom Food"}
            </button>

            {customOpen && (
              <div style={{ marginTop: 12, display: "grid", gap: 10, maxWidth: 560 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  Name
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    style={{ padding: 8 }}
                  />
                </label>

                <label style={{ display: "grid", gap: 6 }}>
                  Serving label (what “1” means)
                  <input
                    value={customServing}
                    onChange={(e) => setCustomServing(e.target.value)}
                    placeholder="e.g., 1 bowl, 1 cup, 1 recipe serving"
                    style={{ padding: 8 }}
                  />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    Calories
                    <input
                      type="number"
                      value={customCalories}
                      onChange={(e) => setCustomCalories(e.target.value)}
                      style={{ padding: 8 }}
                    />
                  </label>

                  <label style={{ display: "grid", gap: 6 }}>
                    Protein (g)
                    <input
                      type="number"
                      value={customProtein}
                      onChange={(e) => setCustomProtein(e.target.value)}
                      style={{ padding: 8 }}
                    />
                  </label>

                  <label style={{ display: "grid", gap: 6 }}>
                    Carbs (g)
                    <input
                      type="number"
                      value={customCarbs}
                      onChange={(e) => setCustomCarbs(e.target.value)}
                      style={{ padding: 8 }}
                    />
                  </label>

                  <label style={{ display: "grid", gap: 6 }}>
                    Fat (g)
                    <input
                      type="number"
                      value={customFat}
                      onChange={(e) => setCustomFat(e.target.value)}
                      style={{ padding: 8 }}
                    />
                  </label>
                </div>

                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={customSaveToQuickAdds}
                    onChange={(e) => setCustomSaveToQuickAdds(e.target.checked)}
                  />
                  Save to Quick Add for next time
                </label>

                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    Qty:
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      style={{ width: 110, padding: 6 }}
                    />
                  </label>

                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    Meal:
                    <select
                      value={mealTag}
                      onChange={(e) => setMealTag(e.target.value)}
                      style={{ padding: 6 }}
                    >
                      {MEAL_TAGS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button onClick={addCustomFood}>Add Custom Food</button>
                </div>
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Barcode lookup (manual)</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="UPC/barcode"
                style={{ flex: "1 1 240px", padding: 8 }}
              />
              <button onClick={() => handleBarcodeLookup()}>Lookup</button>
            </div>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h2 style={{ marginTop: 0 }}>Search (packaged + generic)</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search (e.g., 'Core Power strawberry', 'green curry', 'chicken thigh')"
                style={{ flex: "1 1 240px", padding: 8 }}
              />
              <button onClick={handleSearch}>Search</button>
            </div>
            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>
              Tip: add a USDA API key in Settings to improve generic food coverage.
            </div>
          </div>

          {results.length > 0 && (
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
              <h2 style={{ marginTop: 0 }}>Results</h2>

              <div style={{ display: "grid", gap: 8 }}>
                {results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelected(r)}
                    style={{
                      textAlign: "left",
                      padding: 10,
                      borderRadius: 10,
                      border: selected?.id === r.id ? "2px solid #555" : "1px solid #ddd",
                      background: "#fff",
                    }}
                  >
                    <div>
                      <strong>{r.name}</strong>{" "}
                      <span style={{ opacity: 0.6 }}>({r.source})</span>
                    </div>
                    <div style={{ fontSize: 13, opacity: 0.75 }}>
                      {r.servingSizeLabel} | P {round1(r.macrosPerServing.protein)}g • C{" "}
                      {round1(r.macrosPerServing.carbs)}g • F {round1(r.macrosPerServing.fat)}g •{" "}
                      {round1(r.macrosPerServing.calories)} kcal
                    </div>
                  </button>
                ))}
              </div>

              {selected && (
                <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
                  <h3 style={{ margin: "0 0 8px" }}>Add to today</h3>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ minWidth: 260 }}>
                      <strong>{selected.name}</strong>
                      <div style={{ fontSize: 13, opacity: 0.75 }}>{selected.servingSizeLabel}</div>
                    </div>

                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      Qty:
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={qty}
                        onChange={(e) => setQty(e.target.value)}
                        style={{ width: 90, padding: 6 }}
                      />
                    </label>

                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      Meal:
                      <select value={mealTag} onChange={(e) => setMealTag(e.target.value)} style={{ padding: 6 }}>
                        {MEAL_TAGS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button onClick={addSelectedToLog}>Add</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "quickadds" && (
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Manage Quick Adds</h2>

          <div style={{ display: "grid", gap: 10, maxWidth: 620 }}>
            <label style={{ display: "grid", gap: 6 }}>
              Name
              <input value={qaName} onChange={(e) => setQaName(e.target.value)} style={{ padding: 8 }} />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              Serving label
              <input
                value={qaServing}
                onChange={(e) => setQaServing(e.target.value)}
                placeholder="e.g., 1 bag, 1 bottle, 2 tbsp"
                style={{ padding: 8 }}
              />
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ display: "grid", gap: 6 }}>
                Calories
                <input type="number" value={qaCalories} onChange={(e) => setQaCalories(e.target.value)} style={{ padding: 8 }} />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                Protein (g)
                <input type="number" value={qaProtein} onChange={(e) => setQaProtein(e.target.value)} style={{ padding: 8 }} />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                Carbs (g)
                <input type="number" value={qaCarbs} onChange={(e) => setQaCarbs(e.target.value)} style={{ padding: 8 }} />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                Fat (g)
                <input type="number" value={qaFat} onChange={(e) => setQaFat(e.target.value)} style={{ padding: 8 }} />
              </label>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={saveQuickAdd}>
                {qaEditIndex === null ? "Add Quick Add" : "Save Changes"}
              </button>
              <button onClick={resetQuickAddForm} type="button">
                Clear
              </button>
              {qaEditIndex !== null && (
                <span style={{ opacity: 0.7, fontSize: 13 }}>
                  Editing item #{qaEditIndex + 1}
                </span>
              )}
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <h4 style={{ margin: "0 0 8px" }}>Your Quick Adds</h4>

            {quickAdds.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No quick adds yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {quickAdds.map((q, idx) => (
                  <div
                    key={`${q.name}-${idx}`}
                    style={{
                      border: "1px solid #eee",
                      borderRadius: 10,
                      padding: 10,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ minWidth: 260 }}>
                      <div><strong>{q.name}</strong></div>
                      <div style={{ opacity: 0.75, fontSize: 13 }}>
                        {q.servingSizeLabel} | P {round1(q.macrosPerServing?.protein ?? 0)}g • C{" "}
                        {round1(q.macrosPerServing?.carbs ?? 0)}g • F{" "}
                        {round1(q.macrosPerServing?.fat ?? 0)}g •{" "}
                        {round1(q.macrosPerServing?.calories ?? 0)} kcal
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => startEditQuickAdd(idx)}>Edit</button>
                      <button onClick={() => deleteQuickAdd(idx)}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, display: "grid", gap: 12 }}>
            <h2 style={{ marginTop: 0 }}>Settings</h2>

            <label style={{ display: "grid", gap: 6 }}>
              Protein floor (grams/day)
              <input
                type="number"
                min="0"
                value={proteinFloor}
                onChange={(e) => setProteinFloor(Number(e.target.value))}
                style={{ maxWidth: 180, padding: 8 }}
              />
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              USDA FoodData Central API Key (optional)
              <input
                value={usdaApiKey}
                onChange={(e) => setUsdaApiKey(e.target.value)}
                placeholder="Paste key here (optional)"
                style={{ padding: 8 }}
              />
              <div style={{ opacity: 0.7, fontSize: 13 }}>
                Optional. Packaged foods still work via Open Food Facts without any key.
              </div>
            </label>

            <div style={{ opacity: 0.8, fontSize: 13 }}>
              Road Trip Mode hides totals on the Today screen (but still logs everything).
            </div>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: "0 0 8px" }}>Backup (Export / Import)</h3>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={exportDataJSON}>Export backup (.json)</button>

              <label style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <span>Import backup:</span>
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => importDataJSON(e.target.files?.[0])}
                />
              </label>
            </div>

            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>
              Tip: export once in a while, especially before travel or big edits.
            </div>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: "0 0 8px" }}>Auto Snapshots (local)</h3>
            {snapshots.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No snapshots yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {snapshots.map((s, idx) => (
                  <div
                    key={s.ts}
                    style={{
                      border: "1px solid #eee",
                      borderRadius: 10,
                      padding: 10,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ opacity: 0.8 }}>
                      {new Date(s.ts).toLocaleString()}{" "}
                      <span style={{ opacity: 0.7 }}>
                        (entries: {Array.isArray(s.payload?.entries) ? s.payload.entries.length : 0})
                      </span>
                    </div>
                    <button onClick={() => restoreSnapshot(idx)}>Restore</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
            <h3 style={{ margin: "0 0 8px" }}>Danger Zone</h3>
            <button onClick={wipeAllData} style={{ background: "#fff", border: "1px solid #f0b", padding: 10, borderRadius: 10 }}>
              Wipe all data (this device)
            </button>
            <div style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>
              This is the only path that intentionally allows entries to go to zero and overwrite saved storage.
            </div>
          </div>
        </div>
      )}

      {tab === "report" && (
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16 }}>
          <h2 style={{ marginTop: 0 }}>Weekly Report</h2>
          {!report ? (
            <div style={{ opacity: 0.7 }}>Generate a report to see weekly totals.</div>
          ) : (
            <>
              <div style={{ opacity: 0.8, marginBottom: 10 }}>
                Week of <strong>{report.startISO}</strong> (entries: {report.entryCount})
              </div>

              <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
                <div>
                  <strong>Totals:</strong> {report.totals.protein}g protein • {report.totals.carbs}g carbs •{" "}
                  {report.totals.fat}g fat • {report.totals.calories} kcal
                </div>
                <div>
                  <strong>Daily avg:</strong> {report.averages.protein}g protein • {report.averages.carbs}g carbs •{" "}
                  {report.averages.fat}g fat • {report.averages.calories} kcal
                </div>
              </div>

              <button onClick={exportReportCSV}>Export CSV</button>

              <div style={{ marginTop: 16, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {["Date", "Calories", "Protein", "Carbs", "Fat"].map((h) => (
                        <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #eee", padding: 8 }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.dayRows.map((r) => (
                      <tr key={r.date}>
                        <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.date}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.calories}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.protein}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.carbs}</td>
                        <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>{r.fat}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: 18, opacity: 0.65, fontSize: 12 }}>
        Privacy: stored locally in your browser only. No account, no cloud, no grading.
      </div>
    </div>
  );
}
