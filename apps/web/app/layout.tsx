export const metadata = {
  title: "Pressing OS — Gestion de pressing",
  description: "Gérez vos dépôts, prestations et finances depuis un seul espace.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="fr"><body>{children}</body></html>;
}
