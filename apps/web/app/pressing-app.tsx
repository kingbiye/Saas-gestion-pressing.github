"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  getOfflineSnapshot,
  getPendingDeposits,
  PendingDeposit,
  removePendingDeposit,
  saveOfflineSnapshot,
  savePendingDeposit,
} from "./offline-store";

type Service = { id: string; name: string; priceCents: number };
type DepositItem = {
  id?: string;
  serviceId?: string | null;
  serviceName: string;
  quantity: number;
  unitPriceCents: number;
};
type Deposit = {
  id: string;
  reference: string;
  customerName: string;
  customerPhone?: string | null;
  serviceId?: string | null;
  service?: { name: string } | null;
  items?: DepositItem[];
  status: string;
  priceCents: number;
  paid: boolean;
  pickupAt?: string | null;
  locker?: string | null;
  createdAt: string;
  syncState?: "pending";
};
type DepositLineDraft = { id: string; serviceId: string; quantity: string };
type Expense = { id: string; label: string; amountCents: number; incurredAt: string };
type Report = {
  month: string;
  revenueCents: number;
  expensesCents: number;
  profitCents: number;
  topServices: { name: string; count: number }[];
};
type Billing = {
  plan: string;
  expiresAt: string;
  active: boolean;
};
type AdminTenant = {
  id: string;
  name: string;
  plan: string;
  isActive: boolean;
  trialEndsAt: string;
  subscriptionEndsAt: string | null;
  createdAt: string;
  _count: { users: number; deposits: number };
};
type View = "overview" | "deposits" | "catalog" | "expenses" | "reports" | "shop";
type ShopColorTheme = "forest" | "ocean" | "royal" | "plum" | "terracotta" | "sunrise" | "slate";
type ShopSettings = { name: string; logoDataUrl: string | null; colorTheme: ShopColorTheme };
type OfflineSnapshot = {
  services: Service[];
  deposits: Deposit[];
  expenses: Expense[];
  report: Report | null;
  billing: Billing;
  shop: ShopSettings;
};

const SHOP_COLOR_THEMES: { id: ShopColorTheme; name: string; swatch: string }[] = [
  { id: "forest", name: "Vert forêt", swatch: "#176b4b" },
  { id: "ocean", name: "Bleu océan", swatch: "#146a8a" },
  { id: "royal", name: "Bleu royal", swatch: "#4057a6" },
  { id: "plum", name: "Prune", swatch: "#784a83" },
  { id: "terracotta", name: "Terracotta", swatch: "#a94f36" },
  { id: "sunrise", name: "Ambre", swatch: "#a66a12" },
  { id: "slate", name: "Ardoise", swatch: "#536574" },
];
const PRESSING_SCENES = [
  "/pressing-scenes/machines.jpg",
  "/pressing-scenes/ironing.jpg",
  "/pressing-scenes/steaming.jpg",
  "/pressing-scenes/garments.jpg",
  "/pressing-scenes/pressing-shop.jpg",
];

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Reçu",
  IN_PROGRESS: "En traitement",
  READY: "Prêt",
  PICKED_UP: "Récupéré",
};
const STATUS_ORDER = ["RECEIVED", "IN_PROGRESS", "READY", "PICKED_UP"];
const TRIAL_EXPIRED_MESSAGE = "Votre période d’essai est terminée. Vos données sont conservées. Connectez-vous avec le même compte après le renouvellement de l’accès par l’administrateur.";
const NAV_ITEMS: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "Vue d'ensemble", icon: "⌂" },
  { id: "deposits", label: "Dépôts", icon: "▤" },
  { id: "catalog", label: "Catalogue", icon: "◇" },
  { id: "expenses", label: "Dépenses", icon: "↗" },
  { id: "reports", label: "Rapports", icon: "▥" },
  { id: "shop", label: "Paramètres", icon: "⚙" },
];

function money(cents: number) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(cents / 100);
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00.000Z`));
}

function dateTimeLabel(date: string | null | undefined) {
  if (!date) return "Non précisée";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" }).format(new Date(date));
}

function depositItemSummary(deposit: Deposit) {
  if (deposit.items?.length) {
    return deposit.items.map((item) => `${item.serviceName} × ${item.quantity}`).join(" · ");
  }
  return deposit.service?.name ?? "";
}

function getDepositItems(deposit: Deposit, services: Service[]): DepositItem[] {
  if (deposit.items?.length) return deposit.items;
  return [{
    serviceId: deposit.serviceId,
    serviceName: deposit.service?.name
      ?? services.find((service) => service.id === deposit.serviceId)?.name
      ?? "Article non précisé",
    quantity: 1,
    unitPriceCents: deposit.priceCents,
  }];
}

function readToken(key: string) {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
}

function clearToken(key: string) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
}

function currentOfflineUserKey(): string {
  const token = readToken("pressing_token");
  const payload = token?.split(".")[0];
  if (!payload) throw new Error("Reconnecte-toi en ligne pour préparer le mode hors connexion.");
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(base64 + "=".repeat((4 - base64.length % 4) % 4))) as { sub?: unknown };
    if (typeof decoded.sub !== "string" || !decoded.sub) throw new Error();
    return decoded.sub;
  } catch {
    throw new Error("La session ne permet pas d’identifier le cache hors ligne. Reconnecte-toi.");
  }
}

function mergePendingDeposits(deposits: Deposit[], pending: PendingDeposit<Deposit>[]): Deposit[] {
  const serverReferences = new Set(deposits.map((deposit) => deposit.reference));
  const drafts = pending
    .filter((record) => !serverReferences.has(record.reference))
    .map((record) => ({ ...record.deposit, syncState: "pending" as const }));
  return [...drafts, ...deposits];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = readToken("pressing_admin_token") ?? readToken("pressing_token");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const data: unknown = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const apiError = data && typeof data === "object" && "error" in data
      ? String(data.error)
      : "";
    const knownErrors: Record<string, string> = {
      DATABASE_BUSY: "La base reçoit trop de connexions pour le moment. Réessaie dans quelques secondes.",
      INVALID_LOGO: "Choisis une image PNG, JPEG ou WebP valide de 1 Mo maximum.",
      INVALID_COLOR_THEME: "La couleur choisie n’est pas disponible. Sélectionne une des couleurs proposées.",
      PAYLOAD_TOO_LARGE: "Le fichier est trop volumineux. La taille maximale est de 1 Mo.",
      TENANT_SUSPENDED: "Cette boutique a été bloquée par l’administrateur de la plateforme.",
      TRIAL_EXPIRED: TRIAL_EXPIRED_MESSAGE,
    };
    const message = knownErrors[apiError] || apiError || `La requête a échoué (${response.status}).`;
    throw new Error(message);
  }
  return data as T;
}

function ErrorNotice({ message, onClose }: { message: string; onClose: () => void }) {
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><span>{message}</span><button className="icon-button" onClick={onClose} aria-label="Fermer">×</button></div>;
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return <div className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>;
}

function StatCard({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={`stat-card stat-${tone}`}><p>{label}</p><strong>{value}</strong><span>{detail}</span></article>;
}

function LoadingScreen() {
  return (
    <main
      role="status"
      aria-live="polite"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        color: "#6b7280",
        fontSize: "0.95rem",
      }}
    >
      Chargement de votre espace…
    </main>
  );
}

function DepositRow({ deposit, onAdvance, onPaymentChange, onCancelPending, onPrintReceipt }: {
  deposit: Deposit;
  onAdvance: (deposit: Deposit) => void;
  onPaymentChange: (deposit: Deposit, paid: boolean) => void;
  onCancelPending: (deposit: Deposit) => void;
  onPrintReceipt: (deposit: Deposit) => void;
}) {
  const next = STATUS_ORDER[STATUS_ORDER.indexOf(deposit.status) + 1];
  return (
    <tr>
      <td>
        <strong>{deposit.customerName}</strong>
        <small>#{deposit.reference}</small>
        {depositItemSummary(deposit) && <small>{depositItemSummary(deposit)}</small>}
      </td>
      <td>{deposit.customerPhone || "—"}</td>
      <td>{deposit.syncState === "pending"
        ? <span className="status status-received">En attente de synchronisation</span>
        : <span className={`status status-${deposit.status.toLowerCase()}`}>{STATUS_LABELS[deposit.status] ?? deposit.status}</span>}</td>
      <td><strong>{deposit.locker?.trim() || "—"}</strong></td>
      <td>{money(deposit.priceCents)} FCFA</td>
      <td><div className="payment-options" role="group" aria-label={`Paiement de ${deposit.customerName}`}>
        {[{ value: true, label: "Payé" }, { value: false, label: "Non payé" }].map((option) => (
          <label className={`payment-option ${deposit.paid === option.value ? "payment-option-selected" : ""}`} key={option.label}>
            <input
              type="radio"
              name={`payment-${deposit.id}`}
              checked={deposit.paid === option.value}
              disabled={deposit.syncState === "pending"}
              onChange={() => onPaymentChange(deposit, option.value)}
            />
            {option.label}
          </label>
        ))}
      </div></td>
      <td className="action-cell">
        <button className="button button-small button-secondary" onClick={() => onPrintReceipt(deposit)}>Reçu</button>
        {deposit.syncState === "pending"
          ? <button className="button button-small button-danger" onClick={() => onCancelPending(deposit)}>Annuler</button>
          : next ? <button className="button button-small button-secondary" onClick={() => onAdvance(deposit)}>Passer à « {STATUS_LABELS[next]} »</button> : <span className="muted">Terminé</span>}
      </td>
    </tr>
  );
}

export function PressingApp({ adminPage = false }: { adminPage?: boolean }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [register, setRegister] = useState(true);
  const [forgotMode, setForgotMode] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  // true tant que la session et les données de la boutique ne sont pas chargées :
  // évite d'afficher l'interface par défaut ("Mon pressing", thème vert, 0 FCFA).
  const [booting, setBooting] = useState(true);
  const [isOnline, setIsOnline] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const [pendingDepositCount, setPendingDepositCount] = useState(0);
  const [hasBusinessData, setHasBusinessData] = useState(false);
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);
  const [receiptDownloadError, setReceiptDownloadError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [services, setServices] = useState<Service[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [shop, setShop] = useState<ShopSettings>({ name: "", logoDataUrl: null, colorTheme: "forest" });
  const shopSettingsRevision = useRef(0);
  const shopSettingsWrites = useRef(0);
  const preferredShopTheme = useRef<ShopColorTheme | null>(null);
  const depositSyncInProgress = useRef(false);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [serviceName, setServiceName] = useState("");
  const [servicePrice, setServicePrice] = useState("");
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [depositLines, setDepositLines] = useState<DepositLineDraft[]>([
    { id: "deposit-line-1", serviceId: "", quantity: "1" },
  ]);
  const [pickupAt, setPickupAt] = useState("");
  const [locker, setLocker] = useState("");
  const [paid, setPaid] = useState(false);
  const [receiptDeposit, setReceiptDeposit] = useState<Deposit | null>(null);
  const [expenseLabel, setExpenseLabel] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");

  const refreshBusiness = useCallback(async (selectedMonth = month) => {
    const shopRevisionAtStart = shopSettingsRevision.current;
    const [billingStatus, shopSettings] = await Promise.all([
      request<Billing>("/billing/status"),
      request<ShopSettings>("/settings/shop"),
    ]);
    setBilling(billingStatus);
    if (shopRevisionAtStart === shopSettingsRevision.current && shopSettingsWrites.current === 0) {
      setShop(preferredShopTheme.current
        ? { ...shopSettings, colorTheme: preferredShopTheme.current }
        : shopSettings);
    }
    if (!billingStatus.active) {
      setServices([]);
      setDeposits([]);
      setExpenses([]);
      setReport(null);
      setHasBusinessData(false);
      setOfflineMode(false);
      return;
    }
    const query = new URLSearchParams({ month: selectedMonth });
    const [catalog, depositList, expenseList, monthlyReport] = await Promise.all([
      request<Service[]>("/catalog"),
      request<Deposit[]>("/deposits"),
      request<Expense[]>("/expenses"),
      request<Report>(`/reports/monthly?${query}`),
    ]);
    const userKey = currentOfflineUserKey();
    let pending: PendingDeposit<Deposit>[] = [];
    try {
      pending = await getPendingDeposits<Deposit>(userKey);
    } catch (cause) {
      setError(cause instanceof Error
        ? `Les données sont en ligne, mais le stockage des dépôts hors ligne est indisponible : ${cause.message}`
        : "Les données sont en ligne, mais le stockage des dépôts hors ligne est indisponible.");
    }
    const serverReferences = new Set(depositList.map((deposit) => deposit.reference));
    for (const item of pending) {
      if (serverReferences.has(item.reference)) {
        try {
          await removePendingDeposit(userKey, item.reference);
        } catch (cause) {
          setError(cause instanceof Error
            ? `Le dépôt ${item.reference} est bien sur le serveur, mais sa copie locale n’a pas pu être nettoyée : ${cause.message}`
            : `Le dépôt ${item.reference} est sur le serveur, mais sa copie locale n’a pas pu être nettoyée.`);
        }
      }
    }
    const remainingPending = pending.filter((item) => !serverReferences.has(item.reference));
    setServices(catalog);
    setDeposits(mergePendingDeposits(depositList, remainingPending));
    setExpenses(expenseList);
    setReport(monthlyReport);
    setHasBusinessData(true);
    setPendingDepositCount(remainingPending.length);
    setOfflineMode(false);
    try {
      await saveOfflineSnapshot(userKey, {
        services: catalog,
        deposits: depositList,
        expenses: expenseList,
        report: monthlyReport,
        billing: billingStatus,
        shop: shopSettings,
      } satisfies OfflineSnapshot);
    } catch (cause) {
      setError(cause instanceof Error
        ? `Les données sont chargées, mais n’ont pas pu être mises en cache hors ligne : ${cause.message}`
        : "Les données sont chargées, mais le cache hors ligne n’a pas pu être enregistré.");
    }
  }, [month]);

  const loadOfflineSnapshot = useCallback(async () => {
    const userKey = currentOfflineUserKey();
    const snapshot = await getOfflineSnapshot<OfflineSnapshot>(userKey);
    if (!snapshot) throw new Error("Aucune donnée n’a encore été enregistrée hors ligne. Connecte-toi à Internet puis réessaie.");
    if (!snapshot.billing.active || new Date(snapshot.billing.expiresAt).getTime() <= Date.now()) {
      throw new Error("L’accès à cette boutique a expiré. Reconnecte-toi à Internet pour renouveler l’accès.");
    }
    const pending = await getPendingDeposits<Deposit>(userKey);
    setBilling(snapshot.billing);
    setShop(snapshot.shop);
    setServices(snapshot.services);
    setDeposits(mergePendingDeposits(snapshot.deposits, pending));
    setExpenses(snapshot.expenses);
    setReport(snapshot.report);
    setHasBusinessData(true);
    setPendingDepositCount(pending.length);
    setOfflineMode(true);
  }, []);

  const syncPendingDeposits = useCallback(async () => {
    if (depositSyncInProgress.current || !navigator.onLine || !readToken("pressing_token")) return;
    depositSyncInProgress.current = true;
    try {
      const userKey = currentOfflineUserKey();
      const pending = await getPendingDeposits<Deposit>(userKey);
      setPendingDepositCount(pending.length);
      if (!pending.length) return;
      let synced = 0;
      for (const item of pending) {
        try {
          await request<Deposit>("/deposits", {
            method: "POST",
            body: JSON.stringify(item.payload),
          });
          synced += 1;
        } catch (cause) {
          if (cause instanceof TypeError || !navigator.onLine) break;
          setError(`Le dépôt ${item.reference} reste en attente : ${cause instanceof Error ? cause.message : "échec de synchronisation"}`);
          break;
        }
      }
      const remaining = await getPendingDeposits<Deposit>(userKey);
      setPendingDepositCount(remaining.length);
      if (!navigator.onLine) return;
      await refreshBusiness();
      if (synced > 0) setMessage(`${synced} dépôt(s) synchronisé(s) avec le serveur.`);
    } finally {
      depositSyncInProgress.current = false;
    }
  }, [refreshBusiness]);

  const refreshTenants = useCallback(async () => {
    setTenants(await request<AdminTenant[]>("/admin/tenants"));
  }, []);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const onOnline = () => {
      setIsOnline(true);
      syncPendingDeposits().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "La synchronisation des dépôts en attente a échoué.");
      });
    };
    const onOffline = () => {
      setIsOnline(false);
      if (!adminPage && authenticated) setOfflineMode(true);
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").then(async () => {
        await navigator.serviceWorker.ready;
        const urls = new Set(["/", "/manifest.webmanifest", "/icon.svg"]);
        for (const resource of performance.getEntriesByType("resource")) {
          const url = new URL(resource.name);
          if (url.origin === location.origin
            && (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/pressing-scenes/"))) {
            urls.add(`${url.pathname}${url.search}`);
          }
        }
        const cache = await caches.open("pressing-os-shell-v1");
        const results = await Promise.allSettled([...urls].map((url) => cache.add(url)));
        const failures = results.filter((result) => result.status === "rejected").length;
        if (failures > 0) {
          setError(`${failures} élément(s) de l’application n’ont pas pu être préparés pour le hors connexion. Réessaie avec une connexion stable.`);
        }
      }).catch((cause: unknown) => {
        setError(cause instanceof Error
          ? `L’application ne pourra pas être ouverte hors ligne : ${cause.message}`
          : "L’application ne pourra pas être ouverte hors ligne.");
      });
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [adminPage, authenticated, syncPendingDeposits]);

  useEffect(() => {
    if (adminPage) {
      if (!readToken("pressing_admin_token")) {
        setBooting(false);
        return;
      }
      setAuthenticated(true);
      setAdminAuthenticated(true);
      refreshTenants()
        .catch((cause: unknown) => {
          clearToken("pressing_admin_token");
          setAuthenticated(false);
          setAdminAuthenticated(false);
          setError(cause instanceof Error ? cause.message : "Chargement administrateur impossible.");
        })
        .finally(() => setBooting(false));
      return;
    }

    const token = new URLSearchParams(window.location.search).get("token");
    if (token) {
      setResetToken(token);
      setForgotMode(true);
    }
    if (!readToken("pressing_token")) {
      setBooting(false);
      return;
    }
    setAuthenticated(true);
    refreshBusiness()
      .then(() => syncPendingDeposits().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "La synchronisation des dépôts en attente a échoué.");
      }))
      .catch(async (cause: unknown) => {
        if (!navigator.onLine || cause instanceof TypeError) {
          try {
            await loadOfflineSnapshot();
          } catch (offlineCause) {
            setError(offlineCause instanceof Error ? offlineCause.message : "Impossible de charger les données hors ligne.");
          }
          return;
        }
        clearToken("pressing_token");
        setAuthenticated(false);
        if (cause instanceof Error && cause.message === TRIAL_EXPIRED_MESSAGE) setRegister(false);
        setError(cause instanceof Error ? cause.message : "Chargement de l'espace impossible.");
      })
      .finally(() => setBooting(false));
  }, [adminPage, loadOfflineSnapshot, refreshBusiness, refreshTenants, syncPendingDeposits]);

  const openDeposits = deposits.filter((deposit) => deposit.status !== "PICKED_UP").length;
  const readyDeposits = deposits.filter((deposit) => deposit.status === "READY").length;
  const draftTotalCents = depositLines.reduce((total, line) => {
    const service = services.find((item) => item.id === line.serviceId);
    const quantity = Number(line.quantity);
    return service && Number.isInteger(quantity) && quantity > 0
      ? total + service.priceCents * quantity
      : total;
  }, 0);

  function storeToken(key: string, token: string) {
    clearToken(key === "pressing_token" ? "pressing_admin_token" : "pressing_token");
    (rememberMe ? localStorage : sessionStorage).setItem(key, token);
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (adminPage) {
        const result = await request<{ token: string }>("/admin/login", {
          method: "POST",
          body: JSON.stringify({ email: adminEmail, password: adminPassword }),
        });
        storeToken("pressing_admin_token", result.token);
        await refreshTenants();
        setAuthenticated(true);
        setAdminAuthenticated(true);
      } else {
        const result = await request<{ token: string }>(`/auth/${register ? "register" : "login"}`, {
          method: "POST",
          body: JSON.stringify({ email, password, tenantName }),
        });
        storeToken("pressing_token", result.token);
        await refreshBusiness();
        setAuthenticated(true);
        syncPendingDeposits().catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "La synchronisation des dépôts en attente a échoué.");
        });
      }
    } catch (cause) {
      clearToken(adminPage ? "pressing_admin_token" : "pressing_token");
      setAuthenticated(false);
      setAdminAuthenticated(false);
      if (cause instanceof Error && cause.message === TRIAL_EXPIRED_MESSAGE) setRegister(false);
      setError(cause instanceof Error ? cause.message : "Connexion impossible.");
    } finally {
      setLoading(false);
    }
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);
    try {
      if (resetToken) {
        const result = await request<{ message: string }>("/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ token: resetToken, password: resetPassword }),
        });
        setMessage(result.message);
        setResetToken("");
        setResetPassword("");
        setForgotMode(false);
      } else {
        const result = await request<{ message: string; developmentResetToken?: string }>("/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        setMessage(result.developmentResetToken
          ? `Mode développement — jeton de réinitialisation : ${result.developmentResetToken}`
          : result.message);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La demande de récupération a échoué.");
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action: () => Promise<void>, allowOffline = false) {
    setError("");
    setMessage("");
    if (!isOnline && !allowOffline) {
      setError("Cette action nécessite une connexion Internet. Hors ligne, tu peux consulter les données chargées et enregistrer de nouveaux dépôts.");
      return;
    }
    setLoading(true);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "L'action n'a pas pu aboutir.");
    } finally {
      setLoading(false);
    }
  }

  async function updateShopLogo(file: File | null) {
    if (shopSettingsWrites.current > 0) return;
    shopSettingsWrites.current += 1;
    shopSettingsRevision.current += 1;
    await runAction(async () => {
      try {
        let logoDataUrl: string | null = null;
        if (file) {
          if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 1_048_576) {
            throw new Error("Choisis une image PNG, JPEG ou WebP de 1 Mo maximum.");
          }
          logoDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("La lecture du fichier a échoué."));
            reader.onload = () => {
              if (typeof reader.result === "string") resolve(reader.result);
              else reject(new Error("Le fichier image est invalide."));
            };
            reader.readAsDataURL(file);
          });
        }
        const updatedShop = await request<ShopSettings>("/settings/shop", {
          method: "PATCH",
          body: JSON.stringify({ logoDataUrl }),
        });
        setShop(updatedShop);
        setMessage(file ? "Le logo de votre boutique a été enregistré." : "Le logo de votre boutique a été supprimé.");
      } finally {
        shopSettingsWrites.current -= 1;
        shopSettingsRevision.current += 1;
      }
    });
  }

  async function updateShopColorTheme(colorTheme: ShopColorTheme) {
    if (shopSettingsWrites.current > 0) return;
    shopSettingsWrites.current += 1;
    shopSettingsRevision.current += 1;
    preferredShopTheme.current = colorTheme;
    setShop((currentShop) => ({ ...currentShop, colorTheme }));
    await runAction(async () => {
      try {
        const updatedShop = await request<ShopSettings>("/settings/shop", {
          method: "PATCH",
          body: JSON.stringify({ colorTheme }),
        });
        if (updatedShop.colorTheme !== colorTheme) {
          throw new Error("Le serveur n’a pas confirmé l’enregistrement de cette couleur. Réessaie.");
        }
        setShop((currentShop) => ({ ...updatedShop, colorTheme: preferredShopTheme.current ?? colorTheme }));
        const themeName = SHOP_COLOR_THEMES.find((theme) => theme.id === colorTheme)?.name ?? colorTheme;
        setMessage(`La couleur « ${themeName} » a été appliquée.`);
      } finally {
        shopSettingsWrites.current -= 1;
        shopSettingsRevision.current += 1;
      }
    });
  }

  async function saveService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const body = JSON.stringify({ name: serviceName.trim(), priceCents: Math.round(Number(servicePrice) * 100) });
      await request(editingService ? `/catalog/${editingService.id}` : "/catalog", {
        method: editingService ? "PATCH" : "POST",
        body,
      });
      setServiceName("");
      setServicePrice("");
      setEditingService(null);
      await refreshBusiness();
    });
  }

  async function createDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const reference = `PWA-${crypto.randomUUID()}`;
      if (!navigator.onLine && !hasBusinessData) {
        throw new Error("Connecte-toi à Internet pour charger le catalogue avant d’enregistrer un dépôt hors ligne.");
      }
      if (!navigator.onLine && (!billing?.active || new Date(billing.expiresAt).getTime() <= Date.now())) {
        throw new Error("L’accès de la boutique a expiré. Connecte-toi à Internet pour renouveler l’accès avant d’enregistrer.");
      }
      if (!depositLines.length) {
        throw new Error("Ajoute au moins un article au dépôt.");
      }
      const selectedItems = depositLines.map((line) => {
        const service = services.find((item) => item.id === line.serviceId);
        const quantity = Number(line.quantity);
        if (!service) {
          throw new Error("Choisis un article valide dans le catalogue pour chaque ligne.");
        }
        if (!Number.isInteger(quantity) || quantity < 1) {
          throw new Error("La quantité doit être un nombre entier supérieur à zéro.");
        }
        return {
          serviceId: service.id,
          serviceName: service.name,
          quantity,
          unitPriceCents: service.priceCents,
        };
      });
      const totalPriceCents = selectedItems.reduce(
        (total, item) => total + item.unitPriceCents * item.quantity,
        0,
      );
      if (!Number.isSafeInteger(totalPriceCents) || totalPriceCents > 2_147_483_647) {
        throw new Error("Le montant total du dépôt dépasse la limite autorisée.");
      }
      const payload = {
        reference,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        items: selectedItems.map(({ serviceId, quantity }) => ({ serviceId, quantity })),
        pickupAt: pickupAt ? new Date(pickupAt).toISOString() : undefined,
        locker: locker.trim(),
        paid,
      };
      const draft: Deposit = {
        id: `offline-${reference}`,
        reference,
        customerName: payload.customerName,
        customerPhone: payload.customerPhone || null,
        status: "RECEIVED",
        priceCents: totalPriceCents,
        items: selectedItems,
        paid,
        pickupAt: payload.pickupAt ?? null,
        locker: payload.locker || null,
        createdAt: new Date().toISOString(),
        syncState: "pending",
      };
      const userKey = currentOfflineUserKey();
      await savePendingDeposit(userKey, reference, payload, draft);
      let savedDeposit = draft;
      if (navigator.onLine) {
        let posted = false;
        try {
          savedDeposit = await request<Deposit>("/deposits", { method: "POST", body: JSON.stringify(payload) });
          posted = true;
          await refreshBusiness();
        } catch (cause) {
          if (!posted && !(cause instanceof TypeError) && navigator.onLine) {
            await removePendingDeposit(userKey, reference);
            throw cause;
          }
          setDeposits((current) => mergePendingDeposits(current, [{ key: `${userKey}:${reference}`, userKey, reference, payload, deposit: draft }]));
          setPendingDepositCount((count) => count + 1);
          setMessage(`Dépôt ${reference} enregistré sur cet appareil ; il sera synchronisé au retour d’Internet.`);
        }
      } else {
        setDeposits((current) => mergePendingDeposits(current, [{ key: `${userKey}:${reference}`, userKey, reference, payload, deposit: draft }]));
        setPendingDepositCount((count) => count + 1);
        setMessage(`Dépôt ${reference} enregistré sur cet appareil ; il sera synchronisé au retour d’Internet.`);
      }
      setReceiptDeposit(savedDeposit);
      setCustomerName("");
      setCustomerPhone("");
      setDepositLines([{ id: "deposit-line-1", serviceId: "", quantity: "1" }]);
      setPickupAt("");
      setLocker("");
      setPaid(false);
    }, true);
  }

  async function downloadReceiptPdf() {
    if (!receiptDeposit) return;
    setDownloadingReceipt(true);
    setReceiptDownloadError("");
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ unit: "mm", format: "a5" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 16;
      const contentWidth = pageWidth - margin * 2;
      const receiptItems = getDepositItems(receiptDeposit, services);
      let y = 24;
      const ensureReceiptSpace = (height: number) => {
        if (y + height > pageHeight - 14) {
          pdf.addPage();
          y = 18;
        }
      };

      pdf.setFillColor(23, 107, 75);
      pdf.rect(0, 0, pageWidth, 48, "F");
      pdf.setTextColor(255, 255, 255);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(10);
      pdf.text("REÇU DE DÉPÔT", margin, y);
      y += 10;
      pdf.setFontSize(19);
      const shopName = pdf.splitTextToSize(shop.name || "Mon pressing", contentWidth);
      pdf.text(shopName, margin, y);
      y += shopName.length * 8 + 5;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.text(`Référence : ${receiptDeposit.reference}`, margin, y);

      y = 62;
      const addDetail = (label: string, value: string) => {
        const lines = pdf.splitTextToSize(value, contentWidth * 0.58);
        const detailHeight = Math.max(10, lines.length * 5 + 4);
        ensureReceiptSpace(detailHeight + 2);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.setTextColor(100, 116, 109);
        pdf.text(label, margin, y);
        pdf.setFont("helvetica", "bold");
        pdf.setTextColor(32, 45, 39);
        pdf.text(lines, pageWidth - margin, y, { align: "right" });
        y += detailHeight;
        pdf.setDrawColor(222, 230, 225);
        pdf.line(margin, y - 2, pageWidth - margin, y - 2);
      };

      addDetail("Nom du client", receiptDeposit.customerName);
      addDetail("Date du dépôt", dateTimeLabel(receiptDeposit.createdAt));
      addDetail("Date de récupération", dateTimeLabel(receiptDeposit.pickupAt));
      addDetail("Casier / repère", receiptDeposit.locker?.trim() || "Non renseigné");
      addDetail("Paiement", receiptDeposit.paid ? "Payé" : "Non payé");

      ensureReceiptSpace(18);
      y += 3;
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8);
      pdf.setTextColor(100, 116, 109);
      pdf.text("ARTICLES", margin, y);
      pdf.text("QTÉ", margin + 56, y, { align: "center" });
      pdf.text("PRIX U. (FCFA)", margin + 86, y, { align: "right" });
      pdf.text("SOUS-TOTAL", pageWidth - margin, y, { align: "right" });
      y += 7;
      pdf.setDrawColor(222, 230, 225);
      pdf.line(margin, y - 2, pageWidth - margin, y - 2);
      for (const item of receiptItems) {
        const nameLines = pdf.splitTextToSize(item.serviceName, 45);
        const rowHeight = Math.max(9, nameLines.length * 4 + 4);
        ensureReceiptSpace(rowHeight + 2);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(32, 45, 39);
        pdf.text(nameLines, margin, y);
        pdf.text(String(item.quantity), margin + 56, y, { align: "center" });
        pdf.text(money(item.unitPriceCents).replace(/[\u00a0\u202f]/g, " "), margin + 86, y, { align: "right" });
        pdf.setFont("helvetica", "bold");
        pdf.text(
          money(item.unitPriceCents * item.quantity).replace(/[\u00a0\u202f]/g, " "),
          pageWidth - margin,
          y,
          { align: "right" },
        );
        y += rowHeight;
        pdf.setDrawColor(239, 242, 240);
        pdf.line(margin, y - 2, pageWidth - margin, y - 2);
      }

      ensureReceiptSpace(34);
      y += 3;
      pdf.setFillColor(237, 246, 240);
      pdf.roundedRect(margin, y, contentWidth, 25, 3, 3, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.setTextColor(23, 107, 75);
      pdf.text("MONTANT TOTAL", margin + 5, y + 10);
      const totalText = `${money(receiptDeposit.priceCents).replace(/[\u00a0\u202f]/g, " ")} FCFA`;
      const amountMaxWidth = contentWidth - 10;
      pdf.setFontSize(18);
      const amountFontSize = Math.min(18, (18 * amountMaxWidth) / pdf.getTextWidth(totalText));
      pdf.setFontSize(amountFontSize);
      pdf.setTextColor(32, 45, 39);
      pdf.text(totalText, pageWidth - margin - 5, y + 17, { align: "right" });
      y += 30;

      ensureReceiptSpace(16);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(10);
      pdf.setTextColor(100, 116, 109);
      pdf.text("Merci de votre confiance.", pageWidth / 2, y + 8, { align: "center" });

      const safeReference = receiptDeposit.reference.replace(/[^a-zA-Z0-9_-]/g, "-");
      pdf.save(`recu-${safeReference}.pdf`);
    } catch (cause) {
      setReceiptDownloadError(cause instanceof Error
        ? `Le reçu PDF n’a pas pu être téléchargé : ${cause.message}`
        : "Le reçu PDF n’a pas pu être téléchargé.");
    } finally {
      setDownloadingReceipt(false);
    }
  }

  async function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      await request("/expenses", {
        method: "POST",
        body: JSON.stringify({ label: expenseLabel.trim(), amountCents: Math.round(Number(expenseAmount) * 100) }),
      });
      setExpenseLabel("");
      setExpenseAmount("");
      await refreshBusiness();
    });
  }

  async function updateDeposit(deposit: Deposit, changes: { status?: string; paid?: boolean }) {
    await runAction(async () => {
      await request(`/deposits/${deposit.id}`, { method: "PATCH", body: JSON.stringify(changes) });
      await refreshBusiness();
    });
  }

  async function cancelPendingDeposit(deposit: Deposit) {
    if (!window.confirm(`Annuler le dépôt ${deposit.reference} ? Il ne sera pas envoyé au serveur.`)) return;
    await runAction(async () => {
      const userKey = currentOfflineUserKey();
      await removePendingDeposit(userKey, deposit.reference);
      setDeposits((current) => current.filter((item) => item.reference !== deposit.reference));
      setPendingDepositCount((count) => Math.max(0, count - 1));
      setMessage(`Le dépôt ${deposit.reference} a été annulé sur cet appareil.`);
    }, true);
  }

  async function signOut() {
    clearToken("pressing_token");
    clearToken("pressing_admin_token");
    preferredShopTheme.current = null;
    setAuthenticated(false);
    setAdminAuthenticated(false);
    setError("");
    setMessage("");
  }

  async function updateTenant(tenant: AdminTenant) {
    if (tenant.isActive && !window.confirm(`Bloquer ${tenant.name} ? Ses utilisateurs perdront immédiatement l'accès, mais leurs données seront conservées.`)) return;
    await runAction(async () => {
      await request(`/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !tenant.isActive }),
      });
      await refreshTenants();
    });
  }

  async function unlockExpiredTenant(tenant: AdminTenant) {
    if (!window.confirm(`Débloquer ${tenant.name} et prolonger son accès de 30 jours à partir d’aujourd’hui ?`)) return;
    await runAction(async () => {
      await request(`/admin/tenants/${tenant.id}`, { method: "POST" });
      await refreshTenants();
    });
  }

  async function removeTenant(tenant: AdminTenant) {
    if (!window.confirm(`Supprimer définitivement ${tenant.name} et toutes ses données ?`)) return;
    await runAction(async () => {
      await request(`/admin/tenants/${tenant.id}`, { method: "DELETE" });
      await refreshTenants();
    });
  }

  // Écran de chargement : on n'affiche ni la page de connexion ni l'interface
  // tant que la session et les données de la boutique ne sont pas prêtes.
  if (booting) {
    return <LoadingScreen />;
  }

  if (!authenticated) {
    return (
      <main className="auth-shell">
        <section className="auth-intro">
          <a className="brand brand-light" href="/" aria-label="Pressing OS, accueil"><span className="brand-mark">P</span> pressing<span>OS</span></a>
          <div className="auth-pitch">
            <p className="eyebrow eyebrow-light">LE QUOTIDIEN DU PRESSING, SIMPLIFIÉ</p>
            <h1>Un atelier bien organisé. Des clients bien servis.</h1>
            <p>Suivez chaque dépôt, maîtrisez votre catalogue et gardez un œil clair sur votre activité.</p>
            <div className="auth-points"><span>✓ Suivi des commandes</span><span>✓ Comptes et dépenses</span><span>✓ Rapports mensuels</span></div>
          </div>
          <p className="auth-footnote">Une solution pensée pour les professionnels du pressing.</p>
        </section>
        <section className="auth-panel">
          <div className="auth-card">
            <p className="eyebrow">{forgotMode ? "RÉCUPÉRATION DU COMPTE" : adminPage ? "ESPACE ADMINISTRATEUR" : "ESPACE PROFESSIONNEL"}</p>
            <h2>{forgotMode ? (resetToken ? "Choisir un nouveau mot de passe" : "Mot de passe oublié ?") : adminPage ? "Administration" : register ? "Créer votre espace" : "Ravi de vous revoir"}</h2>
            <p className="muted">{forgotMode ? "Suivez les étapes pour retrouver l'accès à votre compte." : adminPage ? "Connectez-vous pour superviser les boutiques." : register ? "Commencez avec votre essai gratuit de 10 jours." : "Connectez-vous pour retrouver votre activité."}</p>
            <ErrorNotice message={error} onClose={() => setError("")} />
            {message && <div className="notice notice-success" role="status">{message}</div>}
            <form className="form-stack" onSubmit={forgotMode ? submitRecovery : authenticate}>
              {forgotMode ? resetToken ? (
                <label>Nouveau mot de passe<input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} minLength={8} autoComplete="new-password" required /></label>
              ) : (
                <label>Adresse e-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
              ) : adminPage ? (
                <>
                  <label>E-mail administrateur<input type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} autoComplete="username" required /></label>
                  <label>Mot de passe<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="current-password" required /></label>
                </>
              ) : (
                <>
                  {register && <label>Nom du pressing<input value={tenantName} onChange={(event) => setTenantName(event.target.value)} autoComplete="organization" required /></label>}
                  <label>Adresse e-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
                  <label>Mot de passe<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete={register ? "new-password" : "current-password"} required /></label>
                  <label className="check-row"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /> Rester connecté</label>
                  {!adminPage && <small className="offline-login-note">À cocher pour rouvrir l’application hors connexion après fermeture du navigateur.</small>}
                </>
              )}
              <button className="button button-primary button-full" disabled={loading}>{loading ? "Veuillez patienter…" : forgotMode ? resetToken ? "Enregistrer le mot de passe" : "Envoyer les instructions" : adminPage || !register ? "Se connecter" : "Créer mon espace"}</button>
            </form>
            <div className="auth-links">
              {forgotMode ? <button className="text-button" onClick={() => { setForgotMode(false); setMessage(""); setError(""); }}>Retour à la connexion</button> : <>
                {adminPage ? <a className="text-button" href="/">Retour à l'espace professionnel</a> : <>
                  <button className="text-button" onClick={() => { setRegister(!register); setError(""); }}>{register ? "J'ai déjà un compte" : "Créer un compte"}</button>
                  {!register && <button className="text-button" onClick={() => { setForgotMode(true); setError(""); }}>Mot de passe oublié ?</button>}
                </>}
              </>}
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (adminAuthenticated) {
    const totalUsers = tenants.reduce((total, tenant) => total + tenant._count.users, 0);
    const totalOrders = tenants.reduce((total, tenant) => total + tenant._count.deposits, 0);
    return (
      <main className="admin-shell">
        <header className="admin-topbar"><a className="brand" href="/"><span className="brand-mark">P</span> pressing<span>OS</span></a><span className="admin-chip">Administration plateforme</span><button className="button button-secondary" onClick={signOut}>Se déconnecter</button></header>
        <section className="workspace admin-workspace">
          <PageHeading eyebrow="SUPERVISION" title="Gestion des boutiques" description="Bloquez ou réactivez une boutique. Après la période d’essai, vous pouvez lui accorder 30 jours d’accès supplémentaires." />
          <ErrorNotice message={error} onClose={() => setError("")} />
          <div className="stats-grid">
            <StatCard label="Boutiques" value={String(tenants.length)} detail="Espaces enregistrés" />
            <StatCard label="Utilisateurs" value={String(totalUsers)} detail="Comptes associés" />
            <StatCard label="Dépôts" value={String(totalOrders)} detail="Commandes enregistrées" />
          </div>
          <section className="content-card">
            <div className="section-title"><div><p className="eyebrow">COMPTES CLIENTS</p><h2>Boutiques inscrites</h2></div><span className="count-pill">{tenants.length}</span></div>
            {tenants.length ? <div className="table-wrap"><table><thead><tr><th>Boutique</th><th>Inscription</th><th>Plan</th><th>Accès</th><th>État</th><th>Actions</th></tr></thead><tbody>{tenants.map((tenant) => {
              const accessExpiresAt = new Date(tenant.subscriptionEndsAt ?? tenant.trialEndsAt);
              const accessExpired = accessExpiresAt.getTime() <= Date.now();
              return <tr key={tenant.id}>
                <td><strong>{tenant.name}</strong><small>{tenant._count.users} utilisateur(s) · {tenant._count.deposits} dépôt(s)</small></td>
                <td>{new Date(tenant.createdAt).toLocaleDateString("fr-FR")}</td>
                <td>{tenant.plan === "TRIAL" ? "Essai" : tenant.plan === "MONTHLY" ? "Mensuel" : tenant.plan}</td>
                <td>{accessExpiresAt.toLocaleDateString("fr-FR")}</td>
                <td><span className={`status ${tenant.isActive && !accessExpired ? "status-ready" : "status-received"}`}>{!tenant.isActive ? "Suspendue" : accessExpired ? "Accès expiré" : "En service"}</span></td>
                <td className="action-cell">
                  {accessExpired
                    ? <button className="button button-small button-secondary" onClick={() => unlockExpiredTenant(tenant)}>Débloquer 30 jours</button>
                    : <button className={`button button-small ${tenant.isActive ? "button-danger" : "button-secondary"}`} onClick={() => updateTenant(tenant)}>{tenant.isActive ? "Bloquer la boutique" : "Réactiver la boutique"}</button>}
                  <button className="button button-small button-danger" onClick={() => removeTenant(tenant)}>Supprimer</button>
                </td>
              </tr>;
            })}</tbody></table></div> : <p className="empty-state">Aucune boutique enregistrée pour le moment.</p>}
          </section>
        </section>
      </main>
    );
  }

  const heading: Record<View, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: "VOTRE ACTIVITÉ", title: "Vue d'ensemble", description: "Retrouvez en un coup d'œil l'essentiel de votre pressing." },
    deposits: { eyebrow: "SUIVI DES COMMANDES", title: "Dépôts", description: "Enregistrez les vêtements confiés et suivez leur avancement." },
    catalog: { eyebrow: "VOS PRESTATIONS", title: "Catalogue", description: "Gérez les services et tarifs proposés à vos clients." },
    expenses: { eyebrow: "SUIVI FINANCIER", title: "Dépenses", description: "Enregistrez vos frais pour suivre la rentabilité de l'activité." },
    reports: { eyebrow: "ANALYSE", title: "Rapports mensuels", description: "Comparez les recettes et dépenses de votre pressing." },
    shop: { eyebrow: "CONFIGURATION DE VOTRE ESPACE", title: "Paramètres", description: "Gérez l’apparence de votre boutique et contactez l’administrateur." },
  };

  // Initiale affichée dans les pastilles : nom de la boutique d'abord, puis e-mail.
  const shopInitial = (shop.name || email || "P").charAt(0).toUpperCase();

  return (
    <main className="app-shell" data-color-theme={shop.colorTheme}>
      <aside className="sidebar">
        <a
          className="brand brand-light"
          href="/"
          aria-label="pressingOS, retour à la vue d'ensemble"
          onClick={(event) => {
            // Pas de rechargement de la page : on revient simplement à la vue d'ensemble.
            event.preventDefault();
            setView("overview");
            setError("");
            setMessage("");
          }}
        ><span className={`brand-mark ${shop.logoDataUrl ? "brand-mark-logo" : ""}`}>{shop.logoDataUrl ? <img src={shop.logoDataUrl} alt={`Logo ${shop.name}`} /> : shopInitial}</span> pressing<span>OS</span></a>
        <div className="workspace-label">ESPACE DE TRAVAIL</div>
        <nav className="side-nav" aria-label="Navigation principale">
          {NAV_ITEMS.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? "nav-item-active" : ""}`} onClick={() => { setView(item.id); setError(""); }}><span className="nav-icon">{item.icon}</span>{item.label}{item.id === "deposits" && openDeposits > 0 && <span className="nav-count">{openDeposits}</span>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="profile-row"><span className={`avatar ${shop.logoDataUrl ? "avatar-logo" : ""}`}>{shop.logoDataUrl ? <img src={shop.logoDataUrl} alt="" /> : shopInitial}</span><div><strong>{shop.name || "Mon pressing"}</strong><small>{email}</small></div><button className="icon-button light-icon" onClick={signOut} aria-label="Se déconnecter" title="Se déconnecter">↗</button></div>
        </div>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <div className="topbar-scenes" aria-hidden="true">
            {PRESSING_SCENES.map((src, index) => (
              <img
                key={src}
                src={src}
                alt=""
                className="topbar-scene"
                style={{ animationDelay: `${index * -5}s` }}
              />
            ))}
          </div>
          <div className="topbar-shop-name">
            <span className="topbar-caption">Espace professionnel</span>
            <strong title={shop.name}>{shop.name || "Mon pressing"}</strong>
          </div>
          <div className="topbar-actions">
            {billing && <div className={`billing-header-badge ${billing.active ? "" : "billing-header-badge-expired"}`} role="status">
              <strong>{billing.plan === "TRIAL" ? "Période d’essai" : `Offre ${billing.plan}`}</strong>
              <span>{billing.active
                ? `${billing.plan === "TRIAL" ? "Jusqu’au" : "Actif jusqu’au"} ${new Date(billing.expiresAt).toLocaleDateString("fr-FR")}`
                : billing.plan === "TRIAL" ? "Période d’essai expirée" : "Abonnement expiré"}</span>
            </div>}
            <span className="today-label">{new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</span>
            <span className="avatar avatar-small">{shopInitial}</span>
          </div>
        </header>
        <div className="workspace">
          <PageHeading {...heading[view]} />
          {(!isOnline || pendingDepositCount > 0) && <div className={`offline-banner ${isOnline ? "offline-banner-online" : ""}`} role="status">
            <span>{isOnline
              ? `${pendingDepositCount} dépôt(s) en attente de synchronisation.`
              : `Hors connexion${offlineMode ? " — consultation et nouveaux dépôts disponibles" : " — connecte-toi d’abord pour charger les données"}.${pendingDepositCount ? ` ${pendingDepositCount} dépôt(s) en attente.` : ""}`}</span>
            {isOnline && pendingDepositCount > 0 && <button className="button button-small button-secondary" onClick={() => syncPendingDeposits().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Synchronisation impossible."))}>Synchroniser</button>}
          </div>}
          <ErrorNotice message={error} onClose={() => setError("")} />
          {message && <div className="notice notice-success" role="status">{message}</div>}

          {view === "overview" && <>
            <div className="stats-grid">
              <StatCard label="Chiffre d'affaires" value={`${money(report?.revenueCents ?? 0)} FCFA`} detail={monthLabel(month)} />
              <StatCard label="Dépenses" value={`${money(report?.expensesCents ?? 0)} FCFA`} detail={monthLabel(month)} tone="warm" />
              <StatCard label="Résultat net" value={`${money(report?.profitCents ?? 0)} FCFA`} detail="Recettes moins dépenses" tone="green" />
              <StatCard label="Commandes en cours" value={String(openDeposits)} detail={`${readyDeposits} prête(s) au retrait`} tone="blue" />
            </div>
            <div className="overview-grid">
              <section className="content-card">
                <div className="section-title"><div><p className="eyebrow">DERNIÈRES COMMANDES</p><h2>Suivi des dépôts</h2></div><button className="text-button" onClick={() => setView("deposits")}>Voir tout →</button></div>
                {deposits.length ? <div className="table-wrap"><table><thead><tr><th>Client</th><th>Casier / repère</th><th>État</th><th>Montant</th><th>Paiement</th></tr></thead><tbody>{deposits.slice(0, 5).map((deposit) => <tr key={deposit.id}><td><strong>{deposit.customerName}</strong><small>#{deposit.reference}</small></td><td><strong>{deposit.locker?.trim() || "—"}</strong></td><td>{deposit.syncState === "pending" ? <span className="status status-received">À synchroniser</span> : <span className={`status status-${deposit.status.toLowerCase()}`}>{STATUS_LABELS[deposit.status] ?? deposit.status}</span>}</td><td>{money(deposit.priceCents)} FCFA</td><td>{deposit.paid ? <span className="paid-label">Payé</span> : <span className="due-label">À régler</span>}</td></tr>)}</tbody></table></div> : <p className="empty-state">Vos nouveaux dépôts apparaîtront ici.</p>}
              </section>
              <section className="content-card">
                <div className="section-title"><div><p className="eyebrow">RÉSUMÉ DU MOIS</p><h2>{monthLabel(month)}</h2></div><button className="button button-small button-secondary" onClick={() => setView("reports")}>Rapport</button></div>
                <div className="summary-list"><div><span>Prestations enregistrées</span><strong>{report?.topServices.reduce((sum, service) => sum + service.count, 0) ?? 0}</strong></div><div><span>Commandes à retirer</span><strong>{readyDeposits}</strong></div><div><span>Services au catalogue</span><strong>{services.length}</strong></div></div>
                {billing?.plan === "TRIAL" && <p className="trial-note">Votre période d’essai se termine le {new Date(billing.expiresAt).toLocaleDateString("fr-FR")}.</p>}
              </section>
            </div>
          </>}

          {view === "deposits" && <div className="page-grid">
            <section className="content-card form-card">
              <div className="section-title"><div><p className="eyebrow">NOUVELLE COMMANDE</p><h2>Enregistrer un dépôt</h2></div></div>
              <form className="form-stack" onSubmit={createDeposit}>
                <label>Nom du client<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} required /></label>
                <label>Téléphone <span className="optional">Facultatif</span><input type="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></label>
                <fieldset className="deposit-items-fieldset">
                  <legend>Articles et prestations</legend>
                  <div className="deposit-items-editor">
                    {depositLines.map((line, index) => {
                      const selectedService = services.find((service) => service.id === line.serviceId);
                      return <div className="deposit-item-editor" key={line.id}>
                        <label>
                          Article / prestation {index + 1}
                          <select
                            value={line.serviceId}
                            onChange={(event) => setDepositLines((current) => current.map((item) =>
                              item.id === line.id ? { ...item, serviceId: event.target.value } : item))}
                            required
                          >
                            <option value="">Choisir un article</option>
                            {services.map((service) => (
                              <option key={service.id} value={service.id}>
                                {service.name} · {money(service.priceCents)} FCFA / pièce
                              </option>
                            ))}
                          </select>
                          {selectedService && <small>{money(selectedService.priceCents)} FCFA par pièce</small>}
                        </label>
                        <label>
                          Quantité
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={line.quantity}
                            onChange={(event) => setDepositLines((current) => current.map((item) =>
                              item.id === line.id ? { ...item, quantity: event.target.value } : item))}
                            required
                          />
                        </label>
                        {depositLines.length > 1 && (
                          <button
                            className="button button-small button-danger"
                            type="button"
                            aria-label={`Retirer la ligne ${index + 1}`}
                            onClick={() => setDepositLines((current) => current.filter((item) => item.id !== line.id))}
                          >
                            Retirer
                          </button>
                        )}
                      </div>;
                    })}
                  </div>
                  <button
                    className="button button-small button-secondary"
                    type="button"
                    onClick={() => setDepositLines((current) => [
                      ...current,
                      { id: crypto.randomUUID(), serviceId: "", quantity: "1" },
                    ])}
                  >
                    Ajouter un article
                  </button>
                  <div className="deposit-total-preview">
                    <span>Total à payer</span>
                    <strong>{money(draftTotalCents)} FCFA</strong>
                  </div>
                </fieldset>
                <label>Date de retrait <span className="optional">Facultatif</span><input type="datetime-local" value={pickupAt} onChange={(event) => setPickupAt(event.target.value)} /></label>
                <label>Casier / repère <span className="optional">Facultatif</span><input value={locker} onChange={(event) => setLocker(event.target.value)} /></label>
                <fieldset className="payment-fieldset">
                  <legend>Paiement</legend>
                  <div className="payment-choice-row">
                    <label className={`payment-choice ${paid ? "payment-choice-selected" : ""}`}>
                      <input type="radio" name="new-deposit-payment" checked={paid} onChange={() => setPaid(true)} />
                      <span className="payment-choice-indicator" aria-hidden="true">{paid ? "✓" : ""}</span>
                      <span><strong>Payé</strong><small>Le client a réglé</small></span>
                    </label>
                    <label className={`payment-choice ${!paid ? "payment-choice-selected" : ""}`}>
                      <input type="radio" name="new-deposit-payment" checked={!paid} onChange={() => setPaid(false)} />
                      <span className="payment-choice-indicator" aria-hidden="true">{!paid ? "✓" : ""}</span>
                      <span><strong>Non payé</strong><small>À régler au retrait</small></span>
                    </label>
                  </div>
                </fieldset>
                <button className="button button-primary" disabled={loading}>{!isOnline ? "Enregistrer sur cet appareil" : "Enregistrer le dépôt"}</button>
              </form>
            </section>
            <section className="content-card">
              <div className="section-title"><div><p className="eyebrow">ATELIER</p><h2>Tous les dépôts</h2></div><span className="count-pill">{deposits.length}</span></div>
              {deposits.length ? <div className="table-wrap"><table><thead><tr><th>Client</th><th>Téléphone</th><th>État</th><th>Casier / repère</th><th>Montant</th><th>Paiement</th><th>Action</th></tr></thead><tbody>{deposits.map((deposit) => <DepositRow key={deposit.id} deposit={deposit} onAdvance={(item) => updateDeposit(item, { status: STATUS_ORDER[STATUS_ORDER.indexOf(item.status) + 1] })} onPaymentChange={(item, isPaid) => updateDeposit(item, { paid: isPaid })} onCancelPending={(item) => void cancelPendingDeposit(item)} onPrintReceipt={setReceiptDeposit} />)}</tbody></table></div> : <p className="empty-state">Aucun dépôt pour le moment. Enregistrez la première commande.</p>}
            </section>
          </div>}

          {view === "catalog" && <section className="content-card">
            <div className="section-title"><div><p className="eyebrow">OFFRE DE SERVICES</p><h2>Prestations et tarifs</h2></div><span className="count-pill">{services.length} service(s)</span></div>
            <form className="inline-form" onSubmit={saveService}>
              <label>Nom du service<input value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="Ex. Lavage et repassage" required /></label>
              <label>Prix (FCFA)<input type="number" min="0" step="1" value={servicePrice} onChange={(event) => setServicePrice(event.target.value)} placeholder="Ex. 2500" required /></label>
              <button className="button button-primary" disabled={loading || !isOnline}>{editingService ? "Enregistrer" : "Ajouter au catalogue"}</button>
              {editingService && <button type="button" className="button button-secondary" onClick={() => { setEditingService(null); setServiceName(""); setServicePrice(""); }}>Annuler</button>}
            </form>
            <div className="service-grid">{services.map((service) => <article className="service-card" key={service.id}><div className="service-mark">◇</div><div className="service-info"><strong>{service.name}</strong><span>{money(service.priceCents)} FCFA</span></div><div className="service-actions"><button className="icon-button" title="Modifier" aria-label={`Modifier ${service.name}`} onClick={() => { setEditingService(service); setServiceName(service.name); setServicePrice(String(service.priceCents / 100)); }}>✎</button><button className="icon-button icon-danger" title="Supprimer" aria-label={`Supprimer ${service.name}`} onClick={() => runAction(async () => { if (!window.confirm(`Supprimer le service « ${service.name} » ?`)) return; await request(`/catalog/${service.id}`, { method: "DELETE" }); await refreshBusiness(); })}>×</button></div></article>)}</div>
            {!services.length && <p className="empty-state">Ajoutez vos prestations pour accélérer l'enregistrement des dépôts.</p>}
          </section>}

          {view === "expenses" && <div className="page-grid">
            <section className="content-card form-card">
              <div className="section-title"><div><p className="eyebrow">NOUVELLE ÉCRITURE</p><h2>Ajouter une dépense</h2></div></div>
              <form className="form-stack" onSubmit={createExpense}>
                <label>Libellé<input value={expenseLabel} onChange={(event) => setExpenseLabel(event.target.value)} placeholder="Ex. Électricité" required /></label>
                <label>Montant (FCFA)<input type="number" min="1" step="1" value={expenseAmount} onChange={(event) => setExpenseAmount(event.target.value)} required /></label>
                <button className="button button-primary" disabled={loading || !isOnline}>Enregistrer la dépense</button>
              </form>
            </section>
            <section className="content-card">
              <div className="section-title"><div><p className="eyebrow">HISTORIQUE</p><h2>Dernières dépenses</h2></div></div>
              {expenses.length ? <div className="table-wrap"><table><thead><tr><th>Dépense</th><th>Date</th><th>Montant</th></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id}><td><strong>{expense.label}</strong></td><td>{new Date(expense.incurredAt).toLocaleDateString("fr-FR")}</td><td className="amount-negative">− {money(expense.amountCents)} FCFA</td></tr>)}</tbody></table></div> : <p className="empty-state">Aucune dépense enregistrée.</p>}
            </section>
          </div>}

          {view === "reports" && <section className="content-card report-card">
            <div className="section-title"><div><p className="eyebrow">PERFORMANCE</p><h2>Rapport d'activité</h2></div><label className="month-picker">Période<input type="month" value={month} disabled={!isOnline} onChange={(event) => setMonth(event.target.value)} /></label></div>
            <h3 className="report-month">{monthLabel(month)}</h3>
            <div className="stats-grid report-stats"><StatCard label="Chiffre d'affaires" value={`${money(report?.revenueCents ?? 0)} FCFA`} detail="Dépôts enregistrés" /><StatCard label="Dépenses" value={`${money(report?.expensesCents ?? 0)} FCFA`} detail="Dépenses déclarées" tone="warm" /><StatCard label="Résultat net" value={`${money(report?.profitCents ?? 0)} FCFA`} detail="Chiffre d'affaires − dépenses" tone="green" /></div>
            <div className="report-services"><div className="section-title"><div><p className="eyebrow">ACTIVITÉ</p><h2>Prestations les plus demandées</h2></div></div>{report?.topServices.length ? report.topServices.map((service, index) => <div className="popular-row" key={service.name}><span className="popular-rank">{String(index + 1).padStart(2, "0")}</span><strong>{service.name}</strong><span>{service.count} pièce(s)</span></div>) : <p className="empty-state">Aucune prestation enregistrée pour ce mois.</p>}</div>
          </section>}

          {view === "shop" && <section className="content-card shop-settings-card">
            <div className="section-title"><div><p className="eyebrow">ASSISTANCE ET ABONNEMENT</p><h2>Contacter l’administrateur</h2></div></div>
            {billing && <p className="muted">
              {billing.plan === "TRIAL"
                ? `Période d’essai jusqu’au ${new Date(billing.expiresAt).toLocaleDateString("fr-FR")}.`
                : `Accès ${billing.active ? "actif" : "expiré"}${billing.active ? ` jusqu’au ${new Date(billing.expiresAt).toLocaleDateString("fr-FR")}` : ""}.`}
              {" "}Contactez l’administrateur pour renouveler l’accès ou obtenir de l’aide.
            </p>}
            <div className="subscription-actions settings-contact-actions">
              <a className="button button-primary" href="mailto:pressinggestion9@gmail.com?subject=Renouvellement%20Pressing%20OS">
                Envoyer un e-mail
              </a>
              <a className="button button-secondary" href="tel:+242065334385">
                Appeler le +242 06 533 43 85
              </a>
              <a
                className="button button-secondary"
                href="https://wa.me/242065334385?text=Bonjour%2C%20je%20souhaite%20contacter%20l%E2%80%99administrateur%20de%20Pressing%20OS."
                target="_blank"
                rel="noreferrer"
              >
                WhatsApp
              </a>
            </div>
            <a className="settings-contact-email" href="mailto:pressinggestion9@gmail.com">pressinggestion9@gmail.com</a>
          </section>}

          {view === "shop" && <section className="content-card shop-settings-card">
            <div className="section-title"><div><p className="eyebrow">IDENTITÉ DE VOTRE BOUTIQUE</p><h2>Personnaliser l’apparence</h2></div></div>
            <p className="muted">Choisissez l’une des sept couleurs professionnelles. Elle sera enregistrée pour votre boutique.</p>
            <fieldset className="theme-picker">
              <legend>Couleur de l’interface</legend>
              {SHOP_COLOR_THEMES.map((theme) => (
                <label className={`theme-choice ${shop.colorTheme === theme.id ? "theme-choice-selected" : ""}`} key={theme.id}>
                  <input
                    type="radio"
                    name="shop-color-theme"
                    value={theme.id}
                    checked={shop.colorTheme === theme.id}
                    disabled={loading}
                    onChange={() => void updateShopColorTheme(theme.id)}
                  />
                  <span className="theme-swatch" style={{ backgroundColor: theme.swatch }} />
                  <span>{theme.name}</span>
                </label>
              ))}
            </fieldset>
          </section>}

          {view === "shop" && <section className="content-card shop-settings-card">
            <div className="section-title"><div><p className="eyebrow">IMAGE DE MARQUE</p><h2>Logo de la boutique</h2></div></div>
            <p className="muted">Ajoutez le logo de {shop.name || "votre boutique"}. Il apparaîtra dans le menu de votre espace professionnel.</p>
            <div className="shop-logo-editor">
              <div className="shop-logo-preview">
                {shop.logoDataUrl ? <img src={shop.logoDataUrl} alt={`Logo ${shop.name}`} /> : <span>{shopInitial}</span>}
              </div>
              <div className="shop-logo-actions">
                <label className="button button-primary shop-logo-upload">
                  {shop.logoDataUrl ? "Remplacer le logo" : "Importer un logo"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Importer le logo de la boutique"
                    disabled={loading}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = "";
                      if (file) void updateShopLogo(file);
                    }}
                  />
                </label>
                {shop.logoDataUrl && <button className="button button-secondary" disabled={loading} onClick={() => void updateShopLogo(null)}>Retirer le logo</button>}
                <span className="muted">PNG, JPEG ou WebP · 1 Mo maximum</span>
              </div>
            </div>
          </section>}
        </div>
      </section>
      {receiptDeposit && <div className="receipt-backdrop">
        <section className="receipt-modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
          <div className="receipt-actions">
            <button className="button button-secondary" onClick={() => { setReceiptDeposit(null); setReceiptDownloadError(""); }}>Fermer</button>
            <button className="button button-primary" disabled={downloadingReceipt} onClick={() => void downloadReceiptPdf()}>
              {downloadingReceipt ? "Préparation du PDF…" : "Télécharger le reçu PDF"}
            </button>
          </div>
          {receiptDownloadError && <p className="notice notice-error" role="alert">{receiptDownloadError}</p>}
          <article className="receipt">
            <p className="eyebrow">REÇU DE DÉPÔT</p>
            <h1 id="receipt-title">{shop.name || "Mon pressing"}</h1>
            <p className="receipt-reference">Référence : {receiptDeposit.reference}</p>
            <dl className="receipt-details">
              <div><dt>Nom du client</dt><dd>{receiptDeposit.customerName}</dd></div>
              <div><dt>Date du dépôt</dt><dd>{dateTimeLabel(receiptDeposit.createdAt)}</dd></div>
              <div><dt>Date de récupération</dt><dd>{dateTimeLabel(receiptDeposit.pickupAt)}</dd></div>
              <div><dt>Casier / repère</dt><dd>{receiptDeposit.locker?.trim() || "Non renseigné"}</dd></div>
              <div><dt>Paiement</dt><dd>{receiptDeposit.paid ? "Payé" : "Non payé"}</dd></div>
            </dl>
            <div className="receipt-items">
              <p>ARTICLES DÉPOSÉS</p>
              {getDepositItems(receiptDeposit, services).map((item, index) => (
                <div className="receipt-item" key={`${item.serviceId ?? item.serviceName}-${index}`}>
                  <div>
                    <strong>{item.serviceName}</strong>
                    <small>{item.quantity} × {money(item.unitPriceCents)} FCFA</small>
                  </div>
                  <strong>{money(item.unitPriceCents * item.quantity)} FCFA</strong>
                </div>
              ))}
            </div>
            <div className="receipt-total"><span>MONTANT TOTAL</span><strong>{money(receiptDeposit.priceCents)} FCFA</strong></div>
            <p className="receipt-thanks">Merci de votre confiance.</p>
          </article>
        </section>
      </div>}
    </main>
  );
}
