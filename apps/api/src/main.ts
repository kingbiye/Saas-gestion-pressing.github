import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

const currentEnvPath = path.resolve(process.cwd(), ".env");
const monorepoEnvPath = path.resolve(process.cwd(), "..", "..", ".env");
dotenv.config({ path: existsSync(currentEnvPath) ? currentEnvPath : monorepoEnvPath });

const runtimeDatabaseUrl = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : undefined;
if (runtimeDatabaseUrl?.hostname.endsWith(".pooler.supabase.com")) {
  runtimeDatabaseUrl.searchParams.set("connection_limit", "1");
  if (runtimeDatabaseUrl.port === "6543") {
    runtimeDatabaseUrl.searchParams.set("pgbouncer", "true");
  }
}

const globalForPrisma = globalThis as typeof globalThis & { pressingPrisma?: PrismaClient };
const prisma = globalForPrisma.pressingPrisma ?? new PrismaClient(
  runtimeDatabaseUrl ? { datasources: { db: { url: runtimeDatabaseUrl.toString() } } } : undefined,
);
if (process.env.NODE_ENV !== "production") globalForPrisma.pressingPrisma = prisma;
const maxRequestBytes = 1_500_000;
const maxLogoBytes = 1_048_576;
const shopColorThemes = new Set(["forest", "ocean", "royal", "plum", "terracotta", "sunrise", "slate"]);
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const trialDays = Number(process.env.TRIAL_DAYS ?? 10);
const maxLoginAttempts = 5;
const attemptWindowMs = 15 * 60 * 1000;
const developmentAuthSecret = randomBytes(32).toString("hex");
const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
const platformAdminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
const saspayApiKey = process.env.SASPAY_API_KEY?.trim();
const appOrigin = process.env.APP_ORIGIN ?? process.env.WEB_ORIGIN;
const subscriptionPriceXof = 5000;
const subscriptionDurationDays = 30;
const saspayApiUrl = "https://api.saspay.me/api/v1";

export interface ApiRequest extends AsyncIterable<string | Uint8Array> {
  method?: string;
  url?: string;
  headers: { authorization?: string | string[] };
}

export interface ApiResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(chunk?: string): unknown;
}

class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(res: ApiResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "vary": "Origin",
  });
  res.end(JSON.stringify(data));
}

function getAuthSecret(): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be configured in production.");
  }
  return developmentAuthSecret;
}

function signToken(userId: string, role = "USER"): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, role, exp: Date.now() + 7 * 86400000 })).toString("base64url");
  const signature = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token: string): { sub: string; role: string } | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", getAuthSecret()).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; role?: unknown; exp?: unknown };
    return typeof data.sub === "string" && typeof data.role === "string" && typeof data.exp === "number" && data.exp > Date.now()
      ? { sub: data.sub, role: data.role }
      : null;
  } catch {
    return null;
  }
}

async function body(req: ApiRequest): Promise<Record<string, unknown>> {
  let raw = "";
  let size = 0;
  for await (const chunk of req) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    size += Buffer.byteLength(text);
    if (size > maxRequestBytes) throw new ApiRequestError(413, "PAYLOAD_TOO_LARGE");
    raw += text;
  }
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function session(req: ApiRequest, res: ApiResponse, allowExpired = false) {
  const rawAuthorization = req.headers.authorization;
  const rawToken = (Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization)?.replace(/^Bearer\s+/i, "");
  const token = rawToken ? verifyToken(rawToken) : null;
  const user = token?.role !== "PLATFORM_ADMIN" && token?.sub
    ? await prisma.user.findUnique({
      where: { id: token.sub },
      include: {
        tenant: {
          select: { id: true, name: true, isActive: true, trialEndsAt: true, subscriptionEndsAt: true, plan: true },
        },
      },
    })
    : null;
  const tenant = user?.tenant;
  if (!user || !tenant) {
    json(res, 401, { error: "UNAUTHORIZED" });
    return null;
  }
  if (!tenant.isActive) {
    json(res, 403, { error: "TENANT_SUSPENDED" });
    return null;
  }
  const accessEndsAt = tenant.subscriptionEndsAt ?? tenant.trialEndsAt;
  if (!allowExpired && Date.now() > accessEndsAt.getTime()) {
    json(res, 402, { error: "TRIAL_EXPIRED" });
    return null;
  }
  return { user, tenant };
}

function getAppOrigin(): string {
  if (!appOrigin) throw new ApiRequestError(503, "BILLING_NOT_CONFIGURED");
  let parsed: URL;
  try {
    parsed = new URL(appOrigin);
  } catch {
    throw new ApiRequestError(503, "BILLING_NOT_CONFIGURED");
  }
  if (parsed.origin !== appOrigin.replace(/\/$/, "") || (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")) {
    throw new ApiRequestError(503, "BILLING_NOT_CONFIGURED");
  }
  return parsed.origin;
}

async function getSasPayCheckoutStatus(providerSessionId: string) {
  if (!saspayApiKey) throw new ApiRequestError(503, "BILLING_NOT_CONFIGURED");
  let response: Response;
  try {
    response = await fetch(`${saspayApiUrl}/checkout-sessions/${encodeURIComponent(providerSessionId)}/status/`, {
      headers: { Authorization: `Bearer ${saspayApiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("SasPay status request failed:", error);
    throw new ApiRequestError(502, "PAYMENT_PROVIDER_UNAVAILABLE");
  }
  if (!response.ok) {
    console.error("SasPay status request returned HTTP", response.status);
    throw new ApiRequestError(502, "PAYMENT_PROVIDER_ERROR");
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiRequestError(502, "PAYMENT_PROVIDER_INVALID_RESPONSE");
  }
  if (!result || typeof result !== "object" || !("id" in result) || result.id !== providerSessionId) {
    throw new ApiRequestError(502, "PAYMENT_PROVIDER_INVALID_RESPONSE");
  }
  return result as {
    id: string;
    status?: string;
    transaction_status?: string | null;
  };
}

async function reconcileBillingPayment(paymentId: string, providerStatus: Awaited<ReturnType<typeof getSasPayCheckoutStatus>>) {
  if (providerStatus.status === "PAID" && providerStatus.transaction_status === "SUCCESS") {
    await prisma.$transaction(async (transaction) => {
      const payment = await transaction.billingPayment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.status === "PAID") return;
      const claimed = await transaction.billingPayment.updateMany({
        where: { id: payment.id, status: { not: "PAID" } },
        data: { status: "PAID", paidAt: new Date() },
      });
      if (!claimed.count) return;
      const tenant = await transaction.tenant.findUnique({
        where: { id: payment.tenantId },
        select: { trialEndsAt: true, subscriptionEndsAt: true },
      });
      if (!tenant) throw new ApiRequestError(404, "SHOP_NOT_FOUND");
      const accessEndsAt = tenant.subscriptionEndsAt ?? tenant.trialEndsAt;
      const startAt = Math.max(Date.now(), accessEndsAt.getTime());
      await transaction.tenant.update({
        where: { id: payment.tenantId },
        data: {
          plan: "MONTHLY",
          subscriptionEndsAt: new Date(startAt + payment.durationDays * 86400000),
        },
      });
    });
  } else if (providerStatus.status === "EXPIRED"
    || providerStatus.status === "CANCELLED"
    || providerStatus.status === "FAILED"
    || providerStatus.transaction_status === "FAILED") {
    await prisma.billingPayment.updateMany({
      where: { id: paymentId, status: { not: "PAID" } },
      data: {
        status: providerStatus.status === "FAILED" || providerStatus.transaction_status === "FAILED"
          ? "FAILED"
          : providerStatus.status,
      },
    });
  }
  const payment = await prisma.billingPayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new ApiRequestError(404, "BILLING_PAYMENT_NOT_FOUND");
  return payment;
}

function redirect(res: ApiResponse, location: string) {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

function isPlatformAdmin(req: ApiRequest): boolean {
  const rawAuthorization = req.headers.authorization;
  const rawToken = (Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization)?.replace(/^Bearer\s+/i, "");
  return Boolean(rawToken && verifyToken(rawToken)?.role === "PLATFORM_ADMIN");
}

function loginAllowed(email: string): boolean {
  const current = loginAttempts.get(email);
  if (!current || current.resetAt <= Date.now()) return true;
  return current.count < maxLoginAttempts;
}

function recordLoginFailure(email: string) {
  const current = loginAttempts.get(email);
  if (!current || current.resetAt <= Date.now()) {
    loginAttempts.set(email, { count: 1, resetAt: Date.now() + attemptWindowMs });
  } else {
    current.count += 1;
  }
}

export async function handleRequest(req: ApiRequest, res: ApiResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": allowedOrigin,
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-max-age": "86400",
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });

  if (req.method === "GET" && url.pathname === "/billing/return") {
    const paymentId = url.searchParams.get("payment");
    if (!paymentId) return json(res, 400, { error: "BILLING_PAYMENT_REQUIRED" });
    const payment = await prisma.billingPayment.findUnique({ where: { id: paymentId } });
    if (!payment?.providerSessionId) return json(res, 404, { error: "BILLING_PAYMENT_NOT_FOUND" });
    const providerStatus = await getSasPayCheckoutStatus(payment.providerSessionId);
    const updated = await reconcileBillingPayment(payment.id, providerStatus);
    const result = updated.status === "PAID" ? "success" : "pending";
    const pendingPayment = updated.status === "PAID" ? "" : `&payment_id=${encodeURIComponent(payment.id)}`;
    return redirect(res, `${getAppOrigin()}/?billing_payment=${result}${pendingPayment}`);
  }

  if (req.method === "POST" && url.pathname === "/auth/register") {
    const input = await body(req);
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    const tenantName = String(input.tenantName ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || !tenantName) {
      return json(res, 400, { error: "VALID_REGISTRATION_REQUIRED" });
    }
    if (await prisma.user.findUnique({ where: { email } })) return json(res, 409, { error: "EMAIL_EXISTS" });
    const tenant = await prisma.tenant.create({
      data: {
        name: tenantName,
        trialEndsAt: new Date(Date.now() + trialDays * 86400000),
        users: { create: { email, password: hashPassword(password), role: "OWNER" } },
      },
      include: { users: true },
    });
    const user = tenant.users[0];
    return json(res, 201, { token: signToken(user.id), user: { id: user.id, email, role: user.role }, tenant });
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const input = await body(req);
    const email = String(input.email ?? "").trim().toLowerCase();
    if (!loginAllowed(email)) return json(res, 429, { error: "TOO_MANY_ATTEMPTS" });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(String(input.password ?? ""), user.password)) {
      recordLoginFailure(email);
      return json(res, 401, { error: "INVALID_CREDENTIALS" });
    }
    loginAttempts.delete(email);
    return json(res, 200, { token: signToken(user.id), user: { id: user.id, email, role: user.role } });
  }

  if (req.method === "POST" && url.pathname === "/auth/forgot-password") {
    const input = await body(req);
    const email = String(input.email ?? "").trim().toLowerCase();
    const genericResponse = { message: "Si cette adresse existe, un lien de réinitialisation sera envoyé." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 200, genericResponse);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return json(res, 200, genericResponse);
    const rawToken = randomBytes(32).toString("hex");
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await prisma.passwordResetToken.create({
      data: {
        tokenHash: hashResetToken(rawToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    if (process.env.NODE_ENV !== "production") {
      return json(res, 200, { ...genericResponse, developmentResetToken: rawToken });
    }
    return json(res, 200, genericResponse);
  }

  if (req.method === "POST" && url.pathname === "/auth/reset-password") {
    const input = await body(req);
    const token = String(input.token ?? "");
    const password = String(input.password ?? "");
    if (token.length < 32 || password.length < 8) return json(res, 400, { error: "INVALID_RESET_REQUEST" });
    const resetToken = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashResetToken(token) } });
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt.getTime() <= Date.now()) {
      return json(res, 400, { error: "RESET_TOKEN_INVALID_OR_EXPIRED" });
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: resetToken.userId }, data: { password: hashPassword(password) } }),
      prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
    ]);
    return json(res, 200, { message: "Mot de passe réinitialisé. Vous pouvez vous connecter." });
  }

  if (req.method === "POST" && url.pathname === "/admin/login") {
    const input = await body(req);
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    if (!platformAdminEmail || !platformAdminPassword || email !== platformAdminEmail || password !== platformAdminPassword) {
      return json(res, 401, { error: "INVALID_ADMIN_CREDENTIALS" });
    }
    return json(res, 200, { token: signToken(email, "PLATFORM_ADMIN"), role: "PLATFORM_ADMIN" });
  }

  if (url.pathname === "/admin/tenants" && req.method === "GET") {
    if (!isPlatformAdmin(req)) return json(res, 403, { error: "PLATFORM_ADMIN_REQUIRED" });
    return json(res, 200, await prisma.tenant.findMany({
      select: {
        id: true,
        name: true,
        plan: true,
        isActive: true,
        createdAt: true,
        _count: { select: { users: true, deposits: true } },
      },
      orderBy: { createdAt: "desc" },
    }));
  }
  const tenantMatch = url.pathname.match(/^\/admin\/tenants\/([^/]+)$/);
  if (tenantMatch && req.method === "PATCH") {
    if (!isPlatformAdmin(req)) return json(res, 403, { error: "PLATFORM_ADMIN_REQUIRED" });
    const input = await body(req);
    if (typeof input.isActive !== "boolean") return json(res, 400, { error: "INVALID_STATUS" });
    return json(res, 200, await prisma.tenant.update({
      where: { id: tenantMatch[1] },
      data: { isActive: input.isActive },
      select: { id: true, name: true, plan: true, isActive: true, createdAt: true },
    }));
  }
  if (tenantMatch && req.method === "DELETE") {
    if (!isPlatformAdmin(req)) return json(res, 403, { error: "PLATFORM_ADMIN_REQUIRED" });
    await prisma.tenant.delete({ where: { id: tenantMatch[1] } });
    return json(res, 200, { deleted: true });
  }

  const billingCheckoutStatusMatch = url.pathname.match(/^\/billing\/checkout\/([^/]+)\/status$/);
  const isBillingRoute = url.pathname === "/billing/status"
    || url.pathname === "/billing/checkout"
    || Boolean(billingCheckoutStatusMatch);
  const isShopSettingsRead = url.pathname === "/settings/shop" && req.method === "GET";
  const current = await session(req, res, isBillingRoute || isShopSettingsRead);
  if (!current) return;
  if (url.pathname === "/billing/checkout" && req.method === "POST") {
    if (!saspayApiKey) return json(res, 503, { error: "BILLING_NOT_CONFIGURED" });
    const payment = await prisma.billingPayment.create({
      data: {
        tenantId: current.tenant.id,
        amountXof: subscriptionPriceXof,
        durationDays: subscriptionDurationDays,
      },
    });
    const returnUrl = `${getAppOrigin()}/api/billing/return?payment=${encodeURIComponent(payment.id)}`;
    let response: Response;
    try {
      response = await fetch(`${saspayApiUrl}/checkout-sessions/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${saspayApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: `${subscriptionPriceXof}.00`,
          currency: "XOF",
          description: `Abonnement Pressing OS - ${subscriptionDurationDays} jours`,
          customer_email: current.user.email,
          customer_name: current.tenant.name,
          return_url: returnUrl,
          metadata: { billing_payment_id: payment.id },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error("SasPay checkout creation failed:", error);
      await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      throw new ApiRequestError(502, "PAYMENT_PROVIDER_UNAVAILABLE");
    }
    if (!response.ok) {
      console.error("SasPay checkout creation returned HTTP", response.status);
      await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return json(res, 502, { error: "PAYMENT_PROVIDER_ERROR" });
    }
    let checkout: unknown;
    try {
      checkout = await response.json();
    } catch {
      await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return json(res, 502, { error: "PAYMENT_PROVIDER_INVALID_RESPONSE" });
    }
    if (!checkout || typeof checkout !== "object"
      || !("id" in checkout) || typeof checkout.id !== "string"
      || !("checkout_url" in checkout) || typeof checkout.checkout_url !== "string") {
      await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return json(res, 502, { error: "PAYMENT_PROVIDER_INVALID_RESPONSE" });
    }
    let checkoutUrl: URL;
    try {
      checkoutUrl = new URL(checkout.checkout_url);
    } catch {
      await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return json(res, 502, { error: "PAYMENT_PROVIDER_INVALID_RESPONSE" });
    }
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "pay.saspay.me") {
      await prisma.billingPayment.update({ where: { id: payment.id }, data: { status: "FAILED" } });
      return json(res, 502, { error: "PAYMENT_PROVIDER_INVALID_RESPONSE" });
    }
    await prisma.billingPayment.update({
      where: { id: payment.id },
      data: { providerSessionId: checkout.id },
    });
    return json(res, 201, { checkoutUrl: checkoutUrl.toString() });
  }
  if (billingCheckoutStatusMatch && req.method === "GET") {
    const payment = await prisma.billingPayment.findFirst({
      where: { id: billingCheckoutStatusMatch[1], tenantId: current.tenant.id },
    });
    if (!payment?.providerSessionId) return json(res, 404, { error: "BILLING_PAYMENT_NOT_FOUND" });
    const providerStatus = await getSasPayCheckoutStatus(payment.providerSessionId);
    const updated = await reconcileBillingPayment(payment.id, providerStatus);
    return json(res, 200, { status: updated.status, paidAt: updated.paidAt });
  }
  if (url.pathname === "/settings/shop" && req.method === "GET") {
    const shop = await prisma.tenant.findUnique({
      where: { id: current.tenant.id },
      select: { name: true, logoDataUrl: true, colorTheme: true },
    });
    if (!shop) return json(res, 404, { error: "SHOP_NOT_FOUND" });
    return json(res, 200, shop);
  }
  if (url.pathname === "/settings/shop" && req.method === "PATCH") {
    const input = await body(req);
    const logoInput = input.logoDataUrl;
    const themeInput = input.colorTheme;
    if (logoInput !== undefined && logoInput !== null && typeof logoInput !== "string") {
      return json(res, 400, { error: "INVALID_LOGO" });
    }
    if (themeInput !== undefined && (typeof themeInput !== "string" || !shopColorThemes.has(themeInput))) {
      return json(res, 400, { error: "INVALID_COLOR_THEME" });
    }
    if (logoInput === undefined && themeInput === undefined) {
      return json(res, 400, { error: "INVALID_SHOP_SETTINGS" });
    }
    let logoDataUrl: string | null | undefined =
      typeof logoInput === "string" ? logoInput : logoInput === null ? null : undefined;
    if (typeof logoDataUrl === "string") {
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(logoDataUrl);
      if (!match) return json(res, 400, { error: "INVALID_LOGO" });
      const image = Buffer.from(match[2], "base64");
      if (image.toString("base64") !== match[2]) return json(res, 400, { error: "INVALID_LOGO" });
      const isPng = match[1] === "png" && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isJpeg = match[1] === "jpeg" && image.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      const isWebp = match[1] === "webp" && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
      if (!image.length || image.length > maxLogoBytes || !(isPng || isJpeg || isWebp)) {
        return json(res, 400, { error: "INVALID_LOGO" });
      }
      logoDataUrl = `data:image/${match[1]};base64,${image.toString("base64")}`;
    }
    const data: Prisma.TenantUpdateInput = {};
    if (logoInput !== undefined) data.logoDataUrl = logoDataUrl;
    if (typeof themeInput === "string") data.colorTheme = themeInput;
    const tenant = await prisma.tenant.update({
      where: { id: current.tenant.id },
      data,
      select: { name: true, logoDataUrl: true, colorTheme: true },
    });
    return json(res, 200, tenant);
  }
  if (url.pathname === "/catalog" && req.method === "GET") {
    return json(res, 200, await prisma.service.findMany({ where: { tenantId: current.tenant.id } }));
  }
  if (url.pathname === "/catalog" && req.method === "POST") {
    const input = await body(req);
    const name = String(input.name ?? "").trim();
    const priceCents = Number(input.priceCents ?? 0);
    if (!name || !Number.isInteger(priceCents) || priceCents < 0) {
      return json(res, 400, { error: "INVALID_SERVICE" });
    }
    const service = await prisma.service.create({ data: { name, priceCents, tenantId: current.tenant.id } });
    return json(res, 201, service);
  }
  const serviceMatch = url.pathname.match(/^\/catalog\/([^/]+)$/);
  if (serviceMatch && req.method === "PATCH") {
    const service = await prisma.service.findFirst({ where: { id: serviceMatch[1], tenantId: current.tenant.id } });
    if (!service) return json(res, 404, { error: "SERVICE_NOT_FOUND" });
    const input = await body(req);
    const data: { name?: string; priceCents?: number } = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) return json(res, 400, { error: "INVALID_SERVICE" });
      data.name = name;
    }
    if (input.priceCents !== undefined) {
      const priceCents = Number(input.priceCents);
      if (!Number.isInteger(priceCents) || priceCents < 0) return json(res, 400, { error: "INVALID_SERVICE" });
      data.priceCents = priceCents;
    }
    return json(res, 200, await prisma.service.update({ where: { id: service.id }, data }));
  }
  if (serviceMatch && req.method === "DELETE") {
    const service = await prisma.service.findFirst({ where: { id: serviceMatch[1], tenantId: current.tenant.id } });
    if (!service) return json(res, 404, { error: "SERVICE_NOT_FOUND" });
    await prisma.service.delete({ where: { id: service.id } });
    return json(res, 200, { deleted: true });
  }
  if (url.pathname === "/deposits" && req.method === "GET") {
    return json(res, 200, await prisma.deposit.findMany({ where: { tenantId: current.tenant.id }, orderBy: { createdAt: "desc" } }));
  }
  if (url.pathname === "/deposits" && req.method === "POST") {
    const input = await body(req);
    const customerName = String(input.customerName ?? "").trim();
    if (!customerName) return json(res, 400, { error: "CUSTOMER_REQUIRED" });
    const serviceId = typeof input.serviceId === "string" ? input.serviceId : null;
    const service = serviceId
      ? await prisma.service.findFirst({ where: { id: serviceId, tenantId: current.tenant.id } })
      : null;
    if (serviceId && !service) return json(res, 400, { error: "INVALID_SERVICE" });
    const priceCents = input.priceCents === undefined ? service?.priceCents ?? 0 : Number(input.priceCents);
    const pickupAt = input.pickupAt ? new Date(String(input.pickupAt)) : null;
    if (!Number.isInteger(priceCents) || priceCents < 0 || (pickupAt && Number.isNaN(pickupAt.getTime()))) {
      return json(res, 400, { error: "INVALID_DEPOSIT_DETAILS" });
    }
    const deposit = await prisma.deposit.create({
      data: {
        reference: String(input.reference ?? randomUUID().slice(0, 8)),
        customerName,
        customerPhone: input.customerPhone ? String(input.customerPhone).trim() : undefined,
        priceCents,
        paid: input.paid === true,
        pickupAt: pickupAt ?? undefined,
        locker: input.locker ? String(input.locker).trim() : undefined,
        tenantId: current.tenant.id,
        serviceId: serviceId ?? undefined,
      },
    });
    return json(res, 201, deposit);
  }
  const depositMatch = url.pathname.match(/^\/deposits\/([^/]+)$/);
  if (depositMatch && req.method === "PATCH") {
    const deposit = await prisma.deposit.findFirst({ where: { id: depositMatch[1], tenantId: current.tenant.id } });
    if (!deposit) return json(res, 404, { error: "DEPOSIT_NOT_FOUND" });
    const input = await body(req);
    const allowedStatuses = ["RECEIVED", "IN_PROGRESS", "READY", "PICKED_UP"];
    const data: { status?: string; paid?: boolean; pickupAt?: Date; locker?: string } = {};
    if (input.status !== undefined) {
      if (!allowedStatuses.includes(String(input.status))) return json(res, 400, { error: "INVALID_STATUS" });
      data.status = String(input.status);
    }
    if (input.paid !== undefined) {
      if (typeof input.paid !== "boolean") return json(res, 400, { error: "INVALID_PAID" });
      data.paid = input.paid;
    }
    if (input.pickupAt !== undefined) {
      const pickupAt = new Date(String(input.pickupAt));
      if (Number.isNaN(pickupAt.getTime())) return json(res, 400, { error: "INVALID_PICKUP_DATE" });
      data.pickupAt = pickupAt;
    }
    if (input.locker !== undefined) data.locker = String(input.locker).trim();
    return json(res, 200, await prisma.deposit.update({ where: { id: deposit.id }, data }));
  }
  if (url.pathname === "/expenses" && req.method === "GET") {
    return json(res, 200, await prisma.expense.findMany({
      where: { tenantId: current.tenant.id },
      orderBy: { incurredAt: "desc" },
    }));
  }
  if (url.pathname === "/expenses" && req.method === "POST") {
    const input = await body(req);
    const label = String(input.label ?? "").trim();
    const amountCents = Number(input.amountCents ?? 0);
    const incurredAt = input.incurredAt ? new Date(String(input.incurredAt)) : new Date();
    if (!label || !Number.isInteger(amountCents) || amountCents <= 0 || Number.isNaN(incurredAt.getTime())) {
      return json(res, 400, { error: "INVALID_EXPENSE" });
    }
    return json(res, 201, await prisma.expense.create({
      data: { label, amountCents, incurredAt, tenantId: current.tenant.id },
    }));
  }
  if (url.pathname === "/reports/monthly" && req.method === "GET") {
    const month = url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: "INVALID_MONTH" });
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const [depositsInMonth, expensesInMonth] = await Promise.all([
      prisma.deposit.findMany({
        where: { tenantId: current.tenant.id, createdAt: { gte: start, lt: end } },
        include: { service: true },
      }),
      prisma.expense.findMany({ where: { tenantId: current.tenant.id, incurredAt: { gte: start, lt: end } } }),
    ]);
    const revenueCents = depositsInMonth.reduce((total, deposit) => total + deposit.priceCents, 0);
    const expensesCents = expensesInMonth.reduce((total, expense) => total + expense.amountCents, 0);
    const popular = new Map<string, { name: string; count: number }>();
    for (const deposit of depositsInMonth) {
      const name = deposit.service?.name ?? "Autres";
      const currentCount = popular.get(name)?.count ?? 0;
      popular.set(name, { name, count: currentCount + 1 });
    }
    return json(res, 200, {
      month,
      revenueCents,
      expensesCents,
      profitCents: revenueCents - expensesCents,
      topServices: [...popular.values()].sort((a, b) => b.count - a.count),
    });
  }
  if (url.pathname === "/billing/status" && req.method === "GET") {
    const expiresAt = current.tenant.subscriptionEndsAt ?? current.tenant.trialEndsAt;
    const pendingPayment = await prisma.billingPayment.findFirst({
      where: { tenantId: current.tenant.id, status: "PENDING", providerSessionId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return json(res, 200, {
      plan: current.tenant.plan,
      expiresAt,
      active: expiresAt.getTime() > Date.now(),
      paymentPending: current.tenant.plan === "TRIAL",
      checkoutAvailable: Boolean(saspayApiKey && appOrigin),
      pendingPaymentId: pendingPayment?.id ?? null,
    });
  }
  return json(res, 404, { error: "NOT_FOUND" });
}

export function handleRequestError(error: unknown, res: ApiResponse) {
  if (error instanceof ApiRequestError) {
    return json(res, error.status, { error: error.code });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2024") {
    return json(res, 503, { error: "DATABASE_BUSY" });
  }
  console.error("API request failed:", error);
  return json(res, 500, { error: "INTERNAL_SERVER_ERROR" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4000);
  createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => handleRequestError(error, res));
  }).listen(port, () => console.log(`API listening on ${port}`));
}