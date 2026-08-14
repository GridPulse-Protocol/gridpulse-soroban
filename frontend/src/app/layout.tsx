import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GridPulse · Solar Microgrid",
  description:
    "DePIN solar microgrid dashboard: peer-to-peer energy wheeling settled in USDC on Stellar.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
