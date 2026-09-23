import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const trialDays = Number(process.env.TRIAL_DAYS ?? 10);
const maxLoginAttempts = 5;
const attemptWindowMs = 15 * 60 * 1000;
const authSecret = process.env.AUTH_SECRET ?? randomBytes(32).toString("hex");
const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
const platformAdminPassword = process.env.PLATFORM_ADMIN_PASSWORD;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "vary": "Origin",
  });
  res.end(JSON.stringify(data));
}

function signToken(userId: string, role = "USER"): string {
  const payload = Buffer.from(JSON.stringify({ sub: userId, role, exp: Date.now() + 7 * 86400000 })).toString("base64url");
  const signature = createHmac("sha256", authSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token: string): { sub: string; role: string } | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", authSecret).update(payload).digest("base64url");
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

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
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

async function session(req: IncomingMessage, res: ServerResponse) {
  const rawToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const token = rawToken ? verifyToken(rawToken) : null;
  const user = token?.role !== "PLATFORM_ADMIN" && token?.sub
    ? await prisma.user.findUnique({ where: { id: token.sub }, include: { tenant: true } })
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
  if (Date.now() > tenant.trialEndsAt.getTime()) {
    json(res, 402, { error: "TRIAL_EXPIRED" });
    return null;
  }
  return { user, tenant };
}

function isPlatformAdmin(req: IncomingMessage): boolean {
  const rawToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
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

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
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
    const user = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
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
      include: { _count: { select: { users: true, deposits: true } } },
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
    }));
  }
  if (tenantMatch && req.method === "DELETE") {
    if (!isPlatformAdmin(req)) return json(res, 403, { error: "PLATFORM_ADMIN_REQUIRED" });
    await prisma.tenant.delete({ where: { id: tenantMatch[1] } });
    return json(res, 200, { deleted: true });
  }

  const current = await session(req, res);
  if (!current) return;
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
    return json(res, 200, {
      plan: current.tenant.plan,
      expiresAt,
      active: expiresAt.getTime() > Date.now(),
      paymentPending: current.tenant.plan === "TRIAL",
    });
  }
  return json(res, 404, { error: "NOT_FOUND" });
}

if (process.env.VERCEL !== "1") {
  const port = Number(process.env.PORT ?? 4000);
  createServer((req, res) => {
    handleRequest(req, res).catch(() => json(res, 400, { error: "INVALID_REQUEST" }));
  }).listen(port, () => console.log(`API listening on ${port}`));
}