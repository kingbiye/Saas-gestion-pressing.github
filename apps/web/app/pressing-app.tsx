"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

type Service = { id: string; name: string; priceCents: number };
type Deposit = {
  id: string;
  reference: string;
  customerName: string;
  customerPhone?: string | null;
  status: string;
  priceCents: number;
  paid: boolean;
  pickupAt?: string | null;
  locker?: string | null;
  createdAt: string;
};
type Expense = { id: string; label: string; amountCents: number; incurredAt: string };
type Report = {
  month: string;
  revenueCents: number;
  expensesCents: number;
  profitCents: number;
  topServices: { name: string; count: number }[];
};
type Billing = { plan: string; expiresAt: string; active: boolean; paymentPending: boolean };
type AdminTenant = {
  id: string;
  name: string;
  plan: string;
  isActive: boolean;
  createdAt: string;
  _count: { users: number; deposits: number };
};
type View = "overview" | "deposits" | "catalog" | "expenses" | "reports" | "shop";
type ShopColorTheme = "forest" | "ocean" | "royal" | "plum" | "terracotta" | "sunrise" | "slate";
type ShopSettings = { name: string; logoDataUrl: string | null; colorTheme: ShopColorTheme };

const SHOP_COLOR_THEMES: { id: ShopColorTheme; name: string; swatch: string }[] = [
  { id: "forest", name: "Vert forêt", swatch: "#176b4b" },
  { id: "ocean", name: "Bleu océan", swatch: "#146a8a" },
  { id: "royal", name: "Bleu royal", swatch: "#4057a6" },
  { id: "plum", name: "Prune", swatch: "#784a83" },
  { id: "terracotta", name: "Terracotta", swatch: "#a94f36" },
  { id: "sunrise", name: "Ambre", swatch: "#a66a12" },
  { id: "slate", name: "Ardoise", swatch: "#536574" },
];

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Reçu",
  IN_PROGRESS: "En traitement",
  READY: "Prêt",
  PICKED_UP: "Récupéré",
};
const STATUS_ORDER = ["RECEIVED", "IN_PROGRESS", "READY", "PICKED_UP"];
const NAV_ITEMS: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "Vue d'ensemble", icon: "⌂" },
  { id: "deposits", label: "Dépôts", icon: "▤" },
  { id: "catalog", label: "Catalogue", icon: "◇" },
  { id: "expenses", label: "Dépenses", icon: "↗" },
  { id: "reports", label: "Rapports", icon: "▥" },
  { id: "shop", label: "Ma boutique", icon: "⚙" },
];

function money(cents: number) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(cents / 100);
}

function monthLabel(month: string) {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00.000Z`));
}

function readToken(key: string) {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
}

function clearToken(key: string) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
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

function DepositRow({ deposit, onAdvance, onPaymentChange }: {
  deposit: Deposit;
  onAdvance: (deposit: Deposit) => void;
  onPaymentChange: (deposit: Deposit, paid: boolean) => void;
}) {
  const next = STATUS_ORDER[STATUS_ORDER.indexOf(deposit.status) + 1];
  return (
    <tr>
      <td><strong>{deposit.customerName}</strong><small>#{deposit.reference}</small></td>
      <td>{deposit.customerPhone || "—"}</td>
      <td><span className={`status status-${deposit.status.toLowerCase()}`}>{STATUS_LABELS[deposit.status] ?? deposit.status}</span></td>
      <td>{money(deposit.priceCents)} FCFA</td>
      <td><div className="payment-options" role="group" aria-label={`Paiement de ${deposit.customerName}`}>
        {[{ value: true, label: "Payé" }, { value: false, label: "Non payé" }].map((option) => (
          <label className={`payment-option ${deposit.paid === option.value ? "payment-option-selected" : ""}`} key={option.label}>
            <input
              type="radio"
              name={`payment-${deposit.id}`}
              checked={deposit.paid === option.value}
              onChange={() => onPaymentChange(deposit, option.value)}
            />
            {option.label}
          </label>
        ))}
      </div></td>
      <td>{next ? <button className="button button-small button-secondary" onClick={() => onAdvance(deposit)}>Passer à « {STATUS_LABELS[next]} »</button> : <span className="muted">Terminé</span>}</td>
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
  const [view, setView] = useState<View>("overview");
  const [services, setServices] = useState<Service[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [shop, setShop] = useState<ShopSettings>({ name: "", logoDataUrl: null, colorTheme: "forest" });
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [serviceName, setServiceName] = useState("");
  const [servicePrice, setServicePrice] = useState("");
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [depositServiceId, setDepositServiceId] = useState("");
  const [pickupAt, setPickupAt] = useState("");
  const [locker, setLocker] = useState("");
  const [paid, setPaid] = useState(false);
  const [expenseLabel, setExpenseLabel] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");

  const refreshBusiness = useCallback(async (selectedMonth = month) => {
    const query = new URLSearchParams({ month: selectedMonth });
    const [catalog, depositList, expenseList, monthlyReport, billingStatus, shopSettings] = await Promise.all([
      request<Service[]>("/catalog"),
      request<Deposit[]>("/deposits"),
      request<Expense[]>("/expenses"),
      request<Report>(`/reports/monthly?${query}`),
      request<Billing>("/billing/status"),
      request<ShopSettings>("/settings/shop"),
    ]);
    setServices(catalog);
    setDeposits(depositList);
    setExpenses(expenseList);
    setReport(monthlyReport);
    setBilling(billingStatus);
    setShop(shopSettings);
  }, [month]);

  const refreshTenants = useCallback(async () => {
    setTenants(await request<AdminTenant[]>("/admin/tenants"));
  }, []);

  useEffect(() => {
    if (adminPage) {
      if (!readToken("pressing_admin_token")) return;
      setAuthenticated(true);
      setAdminAuthenticated(true);
      refreshTenants().catch((cause: unknown) => {
        clearToken("pressing_admin_token");
        setAuthenticated(false);
        setAdminAuthenticated(false);
        setError(cause instanceof Error ? cause.message : "Chargement administrateur impossible.");
      });
      return;
    }

    const token = new URLSearchParams(window.location.search).get("token");
    if (token) {
      setResetToken(token);
      setForgotMode(true);
    }
    if (!readToken("pressing_token")) return;
    setAuthenticated(true);
    refreshBusiness().catch((cause: unknown) => {
      clearToken("pressing_token");
      setAuthenticated(false);
      setError(cause instanceof Error ? cause.message : "Chargement de l'espace impossible.");
    });
  }, [adminPage, refreshBusiness, refreshTenants]);

  const openDeposits = deposits.filter((deposit) => deposit.status !== "PICKED_UP").length;
  const readyDeposits = deposits.filter((deposit) => deposit.status === "READY").length;

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
        setAuthenticated(true);
        setAdminAuthenticated(true);
        await refreshTenants();
      } else {
        const result = await request<{ token: string }>(`/auth/${register ? "register" : "login"}`, {
          method: "POST",
          body: JSON.stringify({ email, password, tenantName }),
        });
        storeToken("pressing_token", result.token);
        setAuthenticated(true);
        await refreshBusiness();
      }
    } catch (cause) {
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

  async function runAction(action: () => Promise<void>) {
    setError("");
    setMessage("");
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
    await runAction(async () => {
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
    });
  }

  async function updateShopColorTheme(colorTheme: ShopColorTheme) {
    const previousTheme = shop.colorTheme;
    setShop((currentShop) => ({ ...currentShop, colorTheme }));
    await runAction(async () => {
      try {
        const updatedShop = await request<ShopSettings>("/settings/shop", {
          method: "PATCH",
          body: JSON.stringify({ colorTheme }),
        });
        setShop(updatedShop);
        const themeName = SHOP_COLOR_THEMES.find((theme) => theme.id === colorTheme)?.name ?? colorTheme;
        setMessage(`La couleur « ${themeName} » a été appliquée.`);
      } catch (cause) {
        setShop((currentShop) => ({ ...currentShop, colorTheme: previousTheme }));
        throw cause;
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
      await request("/deposits", {
        method: "POST",
        body: JSON.stringify({
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim(),
          serviceId: depositServiceId || undefined,
          pickupAt: pickupAt || undefined,
          locker: locker.trim(),
          paid,
        }),
      });
      setCustomerName("");
      setCustomerPhone("");
      setDepositServiceId("");
      setPickupAt("");
      setLocker("");
      setPaid(false);
      await refreshBusiness();
    });
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

  async function signOut() {
    clearToken("pressing_token");
    clearToken("pressing_admin_token");
    setAuthenticated(false);
    setAdminAuthenticated(false);
    setError("");
    setMessage("");
  }

  async function updateTenant(tenant: AdminTenant) {
    await runAction(async () => {
      await request(`/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !tenant.isActive }),
      });
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
          <PageHeading eyebrow="SUPERVISION" title="Gestion des boutiques" description="Consultez et gérez les espaces inscrits sur la plateforme." />
          <ErrorNotice message={error} onClose={() => setError("")} />
          <div className="stats-grid">
            <StatCard label="Boutiques" value={String(tenants.length)} detail="Espaces enregistrés" />
            <StatCard label="Utilisateurs" value={String(totalUsers)} detail="Comptes associés" />
            <StatCard label="Dépôts" value={String(totalOrders)} detail="Commandes enregistrées" />
          </div>
          <section className="content-card">
            <div className="section-title"><div><p className="eyebrow">COMPTES CLIENTS</p><h2>Boutiques inscrites</h2></div><span className="count-pill">{tenants.length}</span></div>
            {tenants.length ? <div className="table-wrap"><table><thead><tr><th>Boutique</th><th>Activité</th><th>Plan</th><th>État</th><th>Actions</th></tr></thead><tbody>{tenants.map((tenant) => <tr key={tenant.id}><td><strong>{tenant.name}</strong><small>{tenant._count.users} utilisateur(s) · {tenant._count.deposits} dépôt(s)</small></td><td>{new Date(tenant.createdAt).toLocaleDateString("fr-FR")}</td><td>{tenant.plan}</td><td><span className={`status ${tenant.isActive ? "status-ready" : "status-received"}`}>{tenant.isActive ? "Actif" : "Suspendu"}</span></td><td className="action-cell"><button className="button button-small button-secondary" onClick={() => updateTenant(tenant)}>{tenant.isActive ? "Suspendre" : "Réactiver"}</button><button className="button button-small button-danger" onClick={() => removeTenant(tenant)}>Supprimer</button></td></tr>)}</tbody></table></div> : <p className="empty-state">Aucune boutique enregistrée pour le moment.</p>}
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
    shop: { eyebrow: "IDENTITÉ DE VOTRE BOUTIQUE", title: "Ma boutique", description: "Personnalisez votre espace avec le logo de votre pressing." },
  };

  return (
    <main className="app-shell" data-color-theme={shop.colorTheme}>
      <aside className="sidebar">
        <a className="brand brand-light" href="/"><span className={`brand-mark ${shop.logoDataUrl ? "brand-mark-logo" : ""}`}>{shop.logoDataUrl ? <img src={shop.logoDataUrl} alt={`Logo ${shop.name}`} /> : "P"}</span> pressing<span>OS</span></a>
        <div className="workspace-label">ESPACE DE TRAVAIL</div>
        <nav className="side-nav" aria-label="Navigation principale">
          {NAV_ITEMS.map((item) => <button key={item.id} className={`nav-item ${view === item.id ? "nav-item-active" : ""}`} onClick={() => { setView(item.id); setError(""); }}><span className="nav-icon">{item.icon}</span>{item.label}{item.id === "deposits" && openDeposits > 0 && <span className="nav-count">{openDeposits}</span>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          {billing && <div className="trial-card"><span className="trial-icon">✦</span><strong>{billing.plan === "TRIAL" ? "Période d'essai" : `Offre ${billing.plan}`}</strong><p>{billing.plan === "TRIAL" ? `Jusqu'au ${new Date(billing.expiresAt).toLocaleDateString("fr-FR")}` : "Votre espace est actif"}</p></div>}
          <div className="profile-row"><span className={`avatar ${shop.logoDataUrl ? "avatar-logo" : ""}`}>{shop.logoDataUrl ? <img src={shop.logoDataUrl} alt="" /> : (email || "P").charAt(0).toUpperCase()}</span><div><strong>{shop.name || "Mon pressing"}</strong><small>{email}</small></div><button className="icon-button light-icon" onClick={signOut} aria-label="Se déconnecter" title="Se déconnecter">↗</button></div>
        </div>
      </aside>
      <section className="main-area">
        <header className="topbar">
          <div className="topbar-shop-name">
            <span className="topbar-caption">Espace professionnel</span>
            <strong title={shop.name}>{shop.name || "Mon pressing"}</strong>
          </div>
          <div className="topbar-actions"><span className="today-label">{new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</span><span className="avatar avatar-small">{(email || "P").charAt(0).toUpperCase()}</span></div>
        </header>
        <div className="workspace">
          <PageHeading {...heading[view]} />
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
                {deposits.length ? <div className="table-wrap"><table><thead><tr><th>Client</th><th>État</th><th>Montant</th><th>Paiement</th></tr></thead><tbody>{deposits.slice(0, 5).map((deposit) => <tr key={deposit.id}><td><strong>{deposit.customerName}</strong><small>#{deposit.reference}</small></td><td><span className={`status status-${deposit.status.toLowerCase()}`}>{STATUS_LABELS[deposit.status] ?? deposit.status}</span></td><td>{money(deposit.priceCents)} FCFA</td><td>{deposit.paid ? <span className="paid-label">Payé</span> : <span className="due-label">À régler</span>}</td></tr>)}</tbody></table></div> : <p className="empty-state">Vos nouveaux dépôts apparaîtront ici.</p>}
              </section>
              <section className="content-card">
                <div className="section-title"><div><p className="eyebrow">RÉSUMÉ DU MOIS</p><h2>{monthLabel(month)}</h2></div><button className="button button-small button-secondary" onClick={() => setView("reports")}>Rapport</button></div>
                <div className="summary-list"><div><span>Prestations enregistrées</span><strong>{report?.topServices.reduce((sum, service) => sum + service.count, 0) ?? 0}</strong></div><div><span>Commandes à retirer</span><strong>{readyDeposits}</strong></div><div><span>Services au catalogue</span><strong>{services.length}</strong></div></div>
                {billing?.paymentPending && <p className="trial-note">Votre période d'essai se termine le {new Date(billing.expiresAt).toLocaleDateString("fr-FR")}.</p>}
              </section>
            </div>
          </>}

          {view === "deposits" && <div className="page-grid">
            <section className="content-card form-card">
              <div className="section-title"><div><p className="eyebrow">NOUVELLE COMMANDE</p><h2>Enregistrer un dépôt</h2></div></div>
              <form className="form-stack" onSubmit={createDeposit}>
                <label>Nom du client<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} required /></label>
                <label>Téléphone <span className="optional">Facultatif</span><input type="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} /></label>
                <label>Prestation<select value={depositServiceId} onChange={(event) => setDepositServiceId(event.target.value)}><option value="">Choisir un service</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name} · {money(service.priceCents)} FCFA</option>)}</select></label>
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
                <button className="button button-primary" disabled={loading}>Enregistrer le dépôt</button>
              </form>
            </section>
            <section className="content-card">
              <div className="section-title"><div><p className="eyebrow">ATELIER</p><h2>Tous les dépôts</h2></div><span className="count-pill">{deposits.length}</span></div>
              {deposits.length ? <div className="table-wrap"><table><thead><tr><th>Client</th><th>Téléphone</th><th>État</th><th>Montant</th><th>Paiement</th><th>Action</th></tr></thead><tbody>{deposits.map((deposit) => <DepositRow key={deposit.id} deposit={deposit} onAdvance={(item) => updateDeposit(item, { status: STATUS_ORDER[STATUS_ORDER.indexOf(item.status) + 1] })} onPaymentChange={(item, isPaid) => updateDeposit(item, { paid: isPaid })} />)}</tbody></table></div> : <p className="empty-state">Aucun dépôt pour le moment. Enregistrez la première commande.</p>}
            </section>
          </div>}

          {view === "catalog" && <section className="content-card">
            <div className="section-title"><div><p className="eyebrow">OFFRE DE SERVICES</p><h2>Prestations et tarifs</h2></div><span className="count-pill">{services.length} service(s)</span></div>
            <form className="inline-form" onSubmit={saveService}>
              <label>Nom du service<input value={serviceName} onChange={(event) => setServiceName(event.target.value)} placeholder="Ex. Lavage et repassage" required /></label>
              <label>Prix (FCFA)<input type="number" min="0" step="1" value={servicePrice} onChange={(event) => setServicePrice(event.target.value)} placeholder="Ex. 2500" required /></label>
              <button className="button button-primary" disabled={loading}>{editingService ? "Enregistrer" : "Ajouter au catalogue"}</button>
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
                <button className="button button-primary" disabled={loading}>Enregistrer la dépense</button>
              </form>
            </section>
            <section className="content-card">
              <div className="section-title"><div><p className="eyebrow">HISTORIQUE</p><h2>Dernières dépenses</h2></div></div>
              {expenses.length ? <div className="table-wrap"><table><thead><tr><th>Dépense</th><th>Date</th><th>Montant</th></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id}><td><strong>{expense.label}</strong></td><td>{new Date(expense.incurredAt).toLocaleDateString("fr-FR")}</td><td className="amount-negative">− {money(expense.amountCents)} FCFA</td></tr>)}</tbody></table></div> : <p className="empty-state">Aucune dépense enregistrée.</p>}
            </section>
          </div>}

          {view === "reports" && <section className="content-card report-card">
            <div className="section-title"><div><p className="eyebrow">PERFORMANCE</p><h2>Rapport d'activité</h2></div><label className="month-picker">Période<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></div>
            <h3 className="report-month">{monthLabel(month)}</h3>
            <div className="stats-grid report-stats"><StatCard label="Chiffre d'affaires" value={`${money(report?.revenueCents ?? 0)} FCFA`} detail="Dépôts enregistrés" /><StatCard label="Dépenses" value={`${money(report?.expensesCents ?? 0)} FCFA`} detail="Dépenses déclarées" tone="warm" /><StatCard label="Résultat net" value={`${money(report?.profitCents ?? 0)} FCFA`} detail="Chiffre d'affaires − dépenses" tone="green" /></div>
            <div className="report-services"><div className="section-title"><div><p className="eyebrow">ACTIVITÉ</p><h2>Prestations les plus demandées</h2></div></div>{report?.topServices.length ? report.topServices.map((service, index) => <div className="popular-row" key={service.name}><span className="popular-rank">{String(index + 1).padStart(2, "0")}</span><strong>{service.name}</strong><span>{service.count} dépôt(s)</span></div>) : <p className="empty-state">Aucune prestation enregistrée pour ce mois.</p>}</div>
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
                {shop.logoDataUrl ? <img src={shop.logoDataUrl} alt={`Logo ${shop.name}`} /> : <span>{(shop.name || "P").charAt(0).toUpperCase()}</span>}
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
    </main>
  );
}
