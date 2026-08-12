import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "cx-simple-exo",
  description: "Contentful Experiences SDK demo with a token-driven design system",
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
