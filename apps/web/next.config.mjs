/** @type {import("next").NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
