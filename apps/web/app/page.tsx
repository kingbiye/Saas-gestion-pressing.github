"use client";

import { FormEvent, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Service = { id: string; name: string; priceCents: number };
type Deposit = { id: string; reference: string; customerName: string; customerPhone?: string; status: string; priceCents: number; paid: boolean; pickupAt?: string; locker?: string };
type Report = { revenueCents: number; expensesCents: number; profitCents: number };
type Billing = { plan: string; expiresAt: string; active: boolean; paymentPending: boolean };
type AdminTenant = { id: string; name: string; plan: string; isActive: boolean; createdAt: string; _count: { users: number; deposits: number } };

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Reçu",
  IN_PROGRESS: "En cours",
  READY: "Prêt",
  PICKED_UP: "Récupéré",
};

const STATUS_ORDER = ["RECEIVED", "IN_PROGRESS", "READY", "PICKED_UP"];

function nextStatus(status: string): string | null {
  const index = STATUS_ORDER.indexOf(status);
  return index >= 0 && index < STATUS_ORDER.length - 1 ? STATUS_ORDER[index + 1] : null;
}

async function request<T>(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem("pressing_admin_token")
    ?? localStorage.getItem("pressing_token")
    ?? sessionStorage.getItem("pressing_admin_token")
    ?? sessionStorage.getItem("pressing_token");
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Une erreur est survenue.");
  return data as T;
}

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [register, setRegister] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [price, setPrice] = useState("");
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [editingServiceName, setEditingServiceName] = useState("");
  const [editingServicePrice, setEditingServicePrice] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [depositServiceId, setDepositServiceId] = useState("");
  const [pickupAt, setPickupAt] = useState("");
  const [locker, setLocker] = useState("");
  const [paid, setPaid] = useState(false);
  const [expenseLabel, setExpenseLabel] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [report, setReport] = useState<Report>({ revenueCents: 0, expensesCents: 0, profitCents: 0 });
  const [billing, setBilling] = useState<Billing | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [error, setError] = useState("");
  const [adminMode, setAdminMode] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [resetToken, setResetToken] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);

  async function refresh() {
    const [catalog, list, monthly, billingStatus] = await Promise.all([request<Service[]>("/catalog"), request<Deposit[]>("/deposits"), request<Report>("/reports/monthly"), request<Billing>("/billing/status")]);
    setServices(catalog);
    setDeposits(list);
    setReport(monthly);
    setBilling(billingStatus);
  }

  async function refreshTenants() {
    const list = await request<AdminTenant[]>("/admin/tenants");
    setTenants(list);
  }

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) {
      setResetToken(token);
      setForgotMode(true);
    }
    const adminToken = localStorage.getItem("pressing_admin_token") ?? sessionStorage.getItem("pressing_admin_token");
    if (adminToken) {
      setAuthenticated(true);
      setAdminAuthenticated(true);
      setAdminMode(true);
      refreshTenants().catch(() => {
        localStorage.removeItem("pressing_admin_token");
        sessionStorage.removeItem("pressing_admin_token");
        setAuthenticated(false);
        setAdminAuthenticated(false);
        setAdminMode(false);
      });
      return;
    }
    if (localStorage.getItem("pressing_token") ?? sessionStorage.getItem("pressing_token")) {
      setAuthenticated(true);
      refresh().catch(() => {
        localStorage.removeItem("pressing_token");
        sessionStorage.removeItem("pressing_token");
        setAuthenticated(false);
      });
    }
  }, []);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await request<{ token: string }>(`/auth/${register ? "register" : "login"}`, { method: "POST", body: JSON.stringify({ email, password, tenantName }) });
      localStorage.removeItem("pressing_admin_token");
      sessionStorage.removeItem("pressing_admin_token");
      const storage = rememberMe ? localStorage : sessionStorage;
      storage.setItem("pressing_token", result.token);
      setAuthenticated(true);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Action impossible."); }
  }

  async function authenticateAdmin(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await request<{ token: string }>("/admin/login", {
        method: "POST",
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      });
      localStorage.removeItem("pressing_token");
      sessionStorage.removeItem("pressing_token");
      const storage = rememberMe ? localStorage : sessionStorage;
      storage.setItem("pressing_admin_token", result.token);
      setAuthenticated(true);
      setAdminAuthenticated(true);
      await refreshTenants();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connexion administrateur impossible.");
    }

  }

  async function requestPasswordReset(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await request<{ message: string; developmentResetToken?: string }>("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setError(result.developmentResetToken
        ? `Mode développement : utilisez ce jeton dans l'URL ?token=${result.developmentResetToken}`
        : result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Demande impossible.");
    }
  }

  async function resetAccountPassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await request<{ message: string }>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: resetToken, password: resetPassword }),
      });
      setError(result.message);
      setForgotMode(false);
      setResetToken("");
      setResetPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Réinitialisation impossible.");
    }
  }

  async function updateTenant(tenant: AdminTenant) {
    await request(`/admin/tenants/${tenant.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !tenant.isActive }),
    });
    await refreshTenants();
  }

  async function deleteTenant(tenant: AdminTenant) {
    if (!window.confirm(`Supprimer définitivement ${tenant.name} et toutes ses données ?`)) return;
    await request(`/admin/tenants/${tenant.id}`, { method: "DELETE" });
    await refreshTenants();
  }

  async function createService(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/catalog", { method: "POST", body: JSON.stringify({ name: serviceName, priceCents: Number(price) * 100 }) });
      setServiceName(""); setPrice(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Article impossible à créer."); }
  }

  function startEditService(service: Service) {
    setEditingServiceId(service.id);
    setEditingServiceName(service.name);
    setEditingServicePrice(String(service.priceCents / 100));
  }

  async function saveService(event: FormEvent) {
    event.preventDefault();
    if (!editingServiceId) return;
    try {
      await request(`/catalog/${editingServiceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editingServiceName, priceCents: Number(editingServicePrice) * 100 }),
      });
      setEditingServiceId(null);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Modification impossible."); }
  }

  async function removeService(service: Service) {
    if (!window.confirm(`Supprimer l'article "${service.name}" ?`)) return;
    try {
      await request(`/catalog/${service.id}`, { method: "DELETE" });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Suppression impossible."); }
  }

  async function createDeposit(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/deposits", { method: "POST", body: JSON.stringify({ customerName, customerPhone, serviceId: depositServiceId || undefined, pickupAt: pickupAt || undefined, locker, paid }) });
      setCustomerName(""); setCustomerPhone(""); setDepositServiceId(""); setPickupAt(""); setLocker(""); setPaid(false); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Dépôt impossible à créer."); }
  }

  async function advanceDeposit(deposit: Deposit) {
    const next = nextStatus(deposit.status);
    if (!next) return;
    try {
      await request(`/deposits/${deposit.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Mise à jour impossible."); }
  }

  async function toggleDepositPaid(deposit: Deposit) {
    try {
      await request(`/deposits/${deposit.id}`, { method: "PATCH", body: JSON.stringify({ paid: !deposit.paid }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Mise à jour impossible."); }
  }

  async function createExpense(event: FormEvent) {
    event.preventDefault();
    try {
      await request("/expenses", { method: "POST", body: JSON.stringify({ label: expenseLabel, amountCents: Number(expenseAmount) * 100 }) });
      setExpenseLabel(""); setExpenseAmount(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Dépense impossible à créer."); }
  }

  if (!authenticated) {
    if (forgotMode) {
      return <main className="auth"><section className="hero"><small>PRESSING OS</small><h1>Récupérez votre accès.</h1><p>Votre mot de passe n'est jamais affiché ni stocké en clair.</p></section><section className="card"><small>SÉCURITÉ</small><h2>{resetToken ? "Nouveau mot de passe" : "Mot de passe oublié"}</h2><p className="muted">{resetToken ? "Choisissez un nouveau mot de passe sécurisé." : "Saisissez votre email pour recevoir un lien."}</p><form onSubmit={resetToken ? resetAccountPassword : requestPasswordReset}>{!resetToken ? <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email professionnel" required /> : <input type="password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} placeholder="Nouveau mot de passe (8 caractères minimum)" minLength={8} required />}{error && <p className="error">{error}</p>}<button type="submit">{resetToken ? "Réinitialiser" : "Recevoir le lien"}</button></form><button className="link" onClick={() => { setForgotMode(false); setError(""); }}>Retour à la connexion</button></section></main>;
    }
    return <main className="auth"><section className="hero"><small>PRESSING OS</small><h1>Votre pressing, enfin maîtrisé.</h1><p>Articles, dépôts et activité réunis dans un espace simple.</p></section><section className="card"><small>{adminMode ? "ADMINISTRATION PLATEFORME" : "ESPACE PROFESSIONNEL"}</small><h2>{adminMode ? "Administration" : register ? "Créer votre boutique" : "Bon retour"}</h2><p className="muted">{adminMode ? "Gérez les boutiques et les comptes." : register ? "10 jours d'essai gratuit." : "Connectez-vous à votre espace."}</p><form onSubmit={adminMode ? authenticateAdmin : authenticate}>{adminMode ? <><input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="Email administrateur" required /><div className="password-field"><input type={showAdminPassword ? "text" : "password"} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Mot de passe administrateur" required /><button type="button" className="password-toggle" onClick={() => setShowAdminPassword(!showAdminPassword)} aria-label={showAdminPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}>{showAdminPassword ? "Masquer" : "Voir"}</button></div></> : <>{register && <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Nom du pressing" required />}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email professionnel" required /><div className="password-field"><input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mot de passe (8 caractères minimum)" minLength={8} required /><button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}>{showPassword ? "Masquer" : "Voir"}</button></div></>}<label className="check"><input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} /> Se souvenir de moi</label>{error && <p className="error">{error}</p>}<button type="submit">{adminMode ? "Ouvrir l'administration" : register ? "Démarrer l'essai" : "Se connecter"}</button></form>{!adminMode && <button className="link" onClick={() => { setRegister(!register); setError(""); }}>{register ? "J'ai déjà un compte" : "Créer un compte"}</button>}{!adminMode && !register && <button className="link" onClick={() => { setForgotMode(true); setError(""); }}>Mot de passe oublié ?</button>}<button className="link" onClick={() => { setAdminMode(!adminMode); setError(""); }}>{adminMode ? "Retour à l'espace pressing" : "Accès administrateur"}</button></section></main>;
  }

  if (adminAuthenticated) {
    return <main className="dashboard"><header><div><small>PRESSING OS · ADMIN</small><h1>Gestion des boutiques</h1></div><button className="secondary" onClick={() => { localStorage.removeItem("pressing_admin_token"); sessionStorage.removeItem("pressing_admin_token"); localStorage.removeItem("pressing_token"); sessionStorage.removeItem("pressing_token"); setAdminAuthenticated(false); setAdminMode(false); setAuthenticated(false); }}>Se déconnecter</button></header>{error && <p className="error">{error}</p>}<section className="stats"><div><span>Boutiques</span><strong>{tenants.length}</strong></div><div><span>Utilisateurs</span><strong>{tenants.reduce((total, tenant) => total + tenant._count.users, 0)}</strong></div><div><span>Dépôts</span><strong>{tenants.reduce((total, tenant) => total + tenant._count.deposits, 0)}</strong></div></section><section className="panel admin-list"><small>SUPERVISION</small><h2>Comptes clients</h2>{tenants.map((tenant) => <div className="admin-row" key={tenant.id}><div><strong>{tenant.name}</strong><small>{tenant._count.users} utilisateur(s) · {tenant._count.deposits} dépôt(s) · {tenant.plan}</small></div><span className={tenant.isActive ? "badge active-badge" : "badge"}>{tenant.isActive ? "Actif" : "Suspendu"}</span><button className="secondary" onClick={() => updateTenant(tenant)}>{tenant.isActive ? "Suspendre" : "Réactiver"}</button><button className="danger" onClick={() => deleteTenant(tenant)}>Supprimer</button></div>)}{tenants.length === 0 && <p className="muted">Aucune boutique enregistrée.</p>}</section></main>;
  }

  return <main className="dashboard"><header><div><small>PRESSING OS</small><h1>Tableau de bord</h1></div><button className="secondary" onClick={() => { localStorage.removeItem("pressing_token"); sessionStorage.removeItem("pressing_token"); setAuthenticated(false); }}>Se déconnecter</button></header>{error && <p className="error">{error}</p>}{billing && <p className="success">{billing.plan === "TRIAL" ? `Essai gratuit actif jusqu'au ${new Date(billing.expiresAt).toLocaleDateString("fr-FR")}.` : `Plan ${billing.plan} actif.`}</p>}<section className="stats"><div><span>Chiffre d'affaires</span><strong>{report.revenueCents / 100} FCFA</strong></div><div><span>Dépenses</span><strong>{report.expensesCents / 100} FCFA</strong></div><div><span>Bénéfice</span><strong className="active">{report.profitCents / 100} FCFA</strong></div></section><section className="columns"><article className="panel"><small>CATALOGUE</small><h2>Articles & services</h2><form className="row" onSubmit={createService}><input value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="Nom de l'article" required /><input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Prix FCFA" required /><button>Ajouter</button></form>{services.map((service) => editingServiceId === service.id ? <form className="row" key={service.id} onSubmit={saveService}><input value={editingServiceName} onChange={(e) => setEditingServiceName(e.target.value)} required /><input type="number" min="0" value={editingServicePrice} onChange={(e) => setEditingServicePrice(e.target.value)} required /><button>Enregistrer</button><button type="button" className="link" onClick={() => setEditingServiceId(null)}>Annuler</button></form> : <div className="item" key={service.id}><span>{service.name}</span><b>{service.priceCents / 100} FCFA</b><button className="secondary" onClick={() => startEditService(service)}>Modifier</button><button className="danger" onClick={() => removeService(service)}>Supprimer</button></div>)}</article><article className="panel"><small>DÉPÔTS</small><h2>Nouveau dépôt</h2><form onSubmit={createDeposit}><input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Nom du client" required /><input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Téléphone du client" /><select value={depositServiceId} onChange={(e) => setDepositServiceId(e.target.value)}><option value="">Choisir un article</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name} - {service.priceCents / 100} FCFA</option>)}</select><input type="datetime-local" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} /><input value={locker} onChange={(e) => setLocker(e.target.value)} placeholder="Casier (ex. A1)" /><label className="check"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Client déjà payé</label><button>Enregistrer le dépôt</button></form>{deposits.map((deposit) => <div className="item" key={deposit.id}><span>{deposit.customerName}<small>{deposit.reference} · {STATUS_LABELS[deposit.status] ?? deposit.status} · {deposit.paid ? "Payé" : "À payer"}{deposit.locker ? ` · Casier ${deposit.locker}` : ""}</small></span><b>{deposit.priceCents / 100} FCFA</b>{nextStatus(deposit.status) && <button className="secondary" onClick={() => advanceDeposit(deposit)}>{STATUS_LABELS[nextStatus(deposit.status)!]}</button>}<button className="secondary" onClick={() => toggleDepositPaid(deposit)}>{deposit.paid ? "Marquer à payer" : "Marquer payé"}</button></div>)}</article><article className="panel"><small>GESTION</small><h2>Dépenses du mois</h2><form className="row" onSubmit={createExpense}><input value={expenseLabel} onChange={(e) => setExpenseLabel(e.target.value)} placeholder="Libellé" required /><input type="number" min="1" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="Montant FCFA" required /><button>Ajouter</button></form></article></section></main>;
}