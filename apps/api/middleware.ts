import { NextRequest, NextResponse } from "next/server";

// Ajoute ici tous les domaines autorisés à appeler cette API
const allowedOrigins = [
  "https://saas-gestion-pressing-github.saas-gestion-dexpressing.workers.dev",
  "http://localhost:3000", // pour tes tests en local
];

export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin") ?? "";
  const isAllowed = allowedOrigins.includes(origin);

  // Cas 1 : requête "preflight" (le navigateur vérifie avant d'envoyer la vraie requête)
  if (request.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: {
        ...(isAllowed && { "Access-Control-Allow-Origin": origin }),
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  // Cas 2 : requête normale (GET, POST, etc.)
  const response = NextResponse.next();
  if (isAllowed) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return response;
}

// Applique ce middleware à toutes les routes (adapte si besoin, ex: "/api/:path*")
export const config = {
  matcher: "/:path*",
};
