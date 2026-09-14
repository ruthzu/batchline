import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Batchline",
  description: "Batch production dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
