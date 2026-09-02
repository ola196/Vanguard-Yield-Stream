import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vanguard Yield Stream | Soroban Payment Protocol",
  description:
    "Second-by-second RWA yield and payroll streaming on Stellar's Soroban smart contract platform. Trustless, continuous token distribution for the decentralized economy.",
  keywords: [
    "Stellar",
    "Soroban",
    "yield streaming",
    "payment stream",
    "DeFi",
    "RWA",
    "blockchain payroll",
  ],
  openGraph: {
    title: "Vanguard Yield Stream",
    description: "Continuous RWA yield & payroll protocol on Stellar Soroban",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  );
}
